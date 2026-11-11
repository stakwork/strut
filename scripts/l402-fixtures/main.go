// Reference fixtures for strut's src/l402.ts (src/l402.test.ts), made with
// gopkg.in/macaroon.v2: the libmacaroons v2 binary format aperture and lnd
// use. Deterministic but for the third-party caveat's verification id (Go
// encrypts it under a random nonce). Regenerate:
//
//	cd scripts/l402-fixtures && go run . > ../../src/fixtures/l402-macaroons.json
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"

	macaroon "gopkg.in/macaroon.v2"
)

type fixture struct {
	Name     string   `json:"name"`
	Location string   `json:"location"`
	Caveats  []string `json:"caveats"`
	Third    *third   `json:"thirdParty,omitempty"`
	Base64   string   `json:"base64"`
	Hex      string   `json:"hex"`
	Sig      string   `json:"signature"`
}

type third struct {
	Location string `json:"location"`
	Id       string `json:"id"`
	Vid      string `json:"vidHex"`
}

func h(s string) []byte { b := sha256.Sum256([]byte(s)); return b[:] }

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func main() {
	root := make([]byte, 32)
	for i := range root {
		root[i] = byte(i + 1)
	}
	tokenId := h("strut l402 fixture token")
	preimage := h("strut l402 fixture preimage")
	ph := sha256.Sum256(preimage)
	id := append([]byte{0, 0}, ph[:]...)
	id = append(id, tokenId...)
	mac := hmac.New(sha256.New, root)
	mac.Write(tokenId)
	rootKey := mac.Sum(nil)

	four := []string{"services=strut:0", "strut_sats=10250", "strut_credit=7500000", "strut_valid_until=1794340808"}
	strut := append(append([]string{}, four...), "strut_carry=none")
	carry := append(append([]string{}, four...), "strut_carry="+hex.EncodeToString(h("strut l402 fixture earlier token")))
	narrowed := append(append([]string{}, strut...), "strut_capabilities=workflow:acme/voxel/character,step:acme/lookup", "strut_max_charge=2000000", "strut_valid_until=1794000000")

	out := map[string]any{
		"l402RootHex":    hex.EncodeToString(root),
		"tokenIdHex":     hex.EncodeToString(tokenId),
		"preimageHex":    hex.EncodeToString(preimage),
		"paymentHashHex": hex.EncodeToString(ph[:]),
		"identifierHex":  hex.EncodeToString(id),
		"rootKeyHex":     hex.EncodeToString(rootKey),
	}
	var list []fixture
	mk := func(name, loc string, cavs []string, tp bool) {
		m, err := macaroon.New(rootKey, id, loc, macaroon.V2)
		must(err)
		for _, c := range cavs {
			must(m.AddFirstPartyCaveat([]byte(c)))
		}
		f := fixture{Name: name, Location: loc, Caveats: cavs}
		if tp {
			must(m.AddThirdPartyCaveat(h("third party caveat key"), []byte("is-admin"), "https://auth.example"))
			c := m.Caveats()[len(m.Caveats())-1]
			f.Third = &third{Location: c.Location, Id: string(c.Id), Vid: hex.EncodeToString(c.VerificationId)}
		}
		b, err := m.MarshalBinary()
		must(err)
		f.Base64 = base64.StdEncoding.EncodeToString(b)
		f.Hex = hex.EncodeToString(b)
		f.Sig = hex.EncodeToString(m.Signature())
		list = append(list, f)
	}
	mk("minted", "strut", strut, false)
	mk("carry", "strut", carry, false)
	mk("narrowed", "strut", narrowed, false)
	mk("no-location", "", strut, false)
	mk("no-caveats", "strut", nil, false)
	mk("third-party", "strut", strut, true)
	// strut always writes five: a token with four is refused.
	mk("four-caveats", "strut", four, false)
	out["macaroons"] = list
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	must(enc.Encode(out))
}
