import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { BallCollider, CuboidCollider, RigidBody, type RapierRigidBody } from "@react-three/rapier";
import * as THREE from "three";
import { ARENA, live, useGame, type Coin } from "./store";
import { direction, takeJump } from "./input";
import { sound } from "./sound";

// The scene inside <Physics>: the ground, the player, the coins. Each frame
// the player reads the input and sets its own velocity (direct, so it steers
// like a game and not like a marble), the camera follows it, and the clock
// ticks. A coin is a SENSOR: the player passes through it, and the sensor
// reports the touch.

export function World() {
  const coins = useGame((s) => s.coins);
  useFrame((_, dt) => useGame.getState().tick(dt));
  return (
    <>
      <Ground />
      <Player />
      {coins.map((c) => (
        <CoinPickup key={c.id} coin={c} />
      ))}
    </>
  );
}

function Ground() {
  return (
    <RigidBody type="fixed" colliders={false}>
      <CuboidCollider args={[ARENA, 0.5, ARENA]} position={[0, -0.5, 0]} />
      <mesh receiveShadow position={[0, -0.5, 0]}>
        <boxGeometry args={[ARENA * 2, 1, ARENA * 2]} />
        <meshStandardMaterial color="#6cbf6a" />
      </mesh>
    </RigidBody>
  );
}

const RADIUS = 0.5;
const SPEED = 7;
const JUMP = 6;
const START: [number, number, number] = [0, 2, 0];
const CAMERA = new THREE.Vector3(0, 7, 9);
const at = new THREE.Vector3();
const eye = new THREE.Vector3();

function Player() {
  const body = useRef<RapierRigidBody>(null);
  useFrame((state, dt) => {
    const b = body.current;
    if (!b) return;
    const p = b.translation();
    const v = b.linvel();
    live.player = { x: round(p.x), y: round(p.y), z: round(p.z) };
    const jump = takeJump();
    if (useGame.getState().phase === "playing") {
      const d = direction();
      const k = 1 - Math.exp(-8 * dt);
      const grounded = p.y < RADIUS + 0.1 && Math.abs(v.y) < 1;
      b.setLinvel({ x: v.x + (d.x * SPEED - v.x) * k, y: jump && grounded ? JUMP : v.y, z: v.z + (d.z * SPEED - v.z) * k }, true);
      if (jump && grounded) sound.jump();
    }
    if (p.y < -12) {
      b.setTranslation({ x: START[0], y: START[1], z: START[2] }, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    at.set(p.x, p.y, p.z);
    state.camera.position.lerp(eye.copy(at).add(CAMERA), 1 - Math.exp(-4 * dt));
    state.camera.lookAt(at);
  });
  return (
    <RigidBody ref={body} name="player" colliders="ball" position={START} friction={1}>
      <mesh castShadow>
        <sphereGeometry args={[RADIUS, 32, 32]} />
        <meshStandardMaterial color="#f97316" roughness={0.4} />
      </mesh>
    </RigidBody>
  );
}

function CoinPickup({ coin }: { coin: Coin }) {
  const spin = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (spin.current) spin.current.rotation.y += dt * 3;
  });
  return (
    <RigidBody type="fixed" colliders={false} position={coin.position}>
      <BallCollider
        args={[0.6]}
        sensor
        onIntersectionEnter={({ other }) => {
          if (other.rigidBodyObject?.name === "player" && useGame.getState().collect(coin.id)) sound.coin();
        }}
      />
      <group ref={spin}>
        <mesh castShadow rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.4, 0.4, 0.1, 24]} />
          <meshStandardMaterial color="#facc15" emissive="#a16207" emissiveIntensity={0.4} metalness={0.2} roughness={0.35} />
        </mesh>
      </group>
    </RigidBody>
  );
}

const round = (n: number) => Math.round(n * 100) / 100;
