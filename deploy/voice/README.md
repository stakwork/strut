# Voice demo on a confidential VM

Talk to Jamie from Peel, with the org home (strut and the voice service) in an
AMD SEV-SNP virtual machine on EC2: its memory is encrypted, and AWS and the
host can't read it. A demo, not the plan's step 4 (plans/private-voice.md §6),
which needs an attested image and secrets made inside the TEE. AWS has no
Intel TDX, so the plan's dstack path does not apply here.

## 1. The box

SEV-SNP runs on the m6a, c6a and r6a families, in a few regions (the guides
name us-east-2 and eu-west-1; check AWS's
[SEV-SNP page](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/sev-snp.html)).
It costs 10% over on-demand, and can't be turned off on an instance once on.
Speech runs on the CPU, so no GPU.

```bash
AMI=$(aws ssm get-parameter --region us-east-2 \
  --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query Parameter.Value --output text)
aws ec2 run-instances --region us-east-2 --image-id "$AMI" \
  --instance-type m6a.2xlarge --cpu-options AmdSevSnp=enabled \
  --key-name <key> --security-group-ids <group with 22, 80, 443 open> \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=60,VolumeType=gp3}'
```

On the box, `sudo dmesg | grep -i sev` lists `SEV-SNP` among the active
memory encryption features.

## 2. The stack

Point a hostname at the box's IP (or use `<ip with dashes>.sslip.io`), then:

```bash
curl -fsSL https://get.docker.com | sudo sh
scp -r deploy/voice ubuntu@<box>:voice      # from a strut checkout
cd voice && cp env.example .env             # fill it in
sudo docker compose up -d
```

Download the speech models before the first call, or it waits for them
(Kroko 57 MB, Kokoro 350 MB):

```bash
curl -fsS -X POST "https://$HOST/audio/models/zipformer-en-kroko/download" -H "authorization: Bearer $STRUT_API_KEY"
curl -fsS -X POST "https://$HOST/audio/speak" -H "authorization: Bearer $STRUT_API_KEY" \
  -H 'content-type: application/json' -d '{"text":"Hello."}' -o /dev/null
```

## 3. Peel

Mint a person token, which Peel sends as its bearer on `POST /voice/calls`:

```bash
curl -fsS -X POST "https://$HOST/peers/tokens" -H "authorization: Bearer $STRUT_API_KEY" \
  -H 'content-type: application/json' -d '{"actor":"<you>","days":30}'
```

The box is no Hive org, so Peel reaches it through a development profile's
launch arguments (peel `docs/talk.md`, "Trying it locally"):

```sh
-profile <dev> -talkHome https://<host> -talkHomeToken <token>
```

## 4. The attestation

Get the instance's signed SEV-SNP report on the box and check it against
AMD's certificates, as AWS's
[attestation page](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/snp-attestation.html)
and Ubuntu's
[guide](https://documentation.ubuntu.com/aws/en/latest/aws-how-to/instances/launch-and-attest-amd-sev-snp-instances)
show. It proves the VM runs under SEV-SNP with debug off. Its measurement is
the firmware's, not the disk with these images.

## 5. End-to-end encrypted calls

Peel makes a fresh key for every call and sends it with `POST /voice/calls`,
and the voice service and Peel both join the room with it. The central
LiveKit forwards the audio both ways and the live text without being able to
read them (plans/private-voice.md §4, "Step 2").

- It needs a voice image that takes the key (sphinx-voice
  `src/encryption.ts`): with `SPHINX_VOICE_TAG` at `latest`, run
  `sudo docker compose pull voice && sudo docker compose up -d`. And a Peel
  that sends one. Such a Peel refuses a call the voice service answers
  without `encrypted: true`, so update the voice service first.
- TLS ends at Caddy, on this box, so the key reaches only this VM.
- To check it on the box: a participant that joins the call's room without
  the key (anyone with the LiveKit key pair can mint a token for it) hears
  noise and gets no text. sphinx-voice's `scripts/e2ee-call.ts` does that
  against a local LiveKit.

## 6. A private model: Maple

The orchestrator's turns go to Anthropic. To run the voice turns on a private
model, Maple's `gemma4-31b`, instead:

1. Wait for a strut image with the `maple` provider. Until then `maple/…`
   models don't resolve, so leave `VOICE_MODEL` at `haiku`.
2. In `.env`, set `MAPLE_API_KEY` and `VOICE_MODEL=maple/gemma4-31b`. Also
   set `MAPLE_CACHE_NAMESPACE_ROOT` (`openssl rand -base64 32`, once), or
   Maple's prompt cache starts over each time the proxy restarts.
3. `sudo docker compose up -d`.

The `maple` service is Maple's proxy
([README](https://github.com/MaplePrivacyLabs/Maple/blob/master/proxy/README.md)).
- It attests Maple's AWS Nitro enclave and encrypts each request to it.
  Maple's enclave verifies the model's enclave before forwarding.
- It reads the prompts in plaintext, so it runs on this box beside strut,
  with no port and no route.
- strut reaches it at `MAPLE_BASE_URL` (`http://maple:8080/v1`) and sends
  `MAPLE_API_KEY` on every request. The proxy holds no key.

Speech stays in strut. Turns outside a call keep their own model.

## What this demo is not

- **The code isn't attested:** the report doesn't cover the images, and
  whoever has the SSH key reads everything on the box.
- **The LiveKit signaling isn't encrypted:** the room name, the random
  identities and the agent's state are LiveKit's to see (§5 covers the audio
  and the text).
- **The model call leaves the box:** each turn goes to Anthropic, or with
  Maple (above) encrypted to Maple's enclave. With Maple, the proxy on this box
  reads it in plaintext first, and the box's code isn't attested.
- **Peel shows no "verified":** that's step 4.
- **The box holds a LiveKit key pair:** make one for it rather than share the
  swarms'. A key pair is admin over every room on the server, though an
  encrypted call's room gives it only ciphertext.
