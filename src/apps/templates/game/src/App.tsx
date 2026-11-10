import { Suspense, useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Physics } from "@react-three/rapier";
import { Sky } from "@react-three/drei";
import { Volume2, VolumeX } from "lucide-react";
import { useAppState } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { World } from "./game/World";
import { listen, takeJump } from "./game/input";
import { live, useGame } from "./game/store";
import { sound } from "./game/sound";
import "./styles.css";

// A game is a canvas with React around it: the 3D scene (React Three Fiber,
// Rapier physics inside <Physics>) fills the frame, and the HUD and menus are
// ordinary components over it. The frame loop never sets React state; it
// writes the store and `live` (src/game/store.ts).

declare global {
  interface Window {
    /** What `app/look` reads off the page: a value, or a function returning one. */
    __debug?: unknown;
  }
}

export default function App() {
  const surface = useRef<HTMLDivElement>(null);
  const phase = useGame((s) => s.phase);
  const score = useGame((s) => s.score);
  const seconds = useGame((s) => Math.ceil(s.timeLeft));
  // The best score: this player's, on every device — the page has no
  // localStorage of its own (useAppState is strut's, per app and viewer).
  const [best, setBest, { loaded }] = useAppState("best", 0);
  const [muted, setMuted] = useState(false);

  useEffect(() => (surface.current ? listen(surface.current) : undefined), []);

  useEffect(() => {
    if (phase !== "over") return;
    sound.over();
    if (score > best) setBest(score);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // The game's state for app/look: a canvas has no text to read.
  const bestNow = useRef(best);
  bestNow.current = best;
  useEffect(() => {
    window.__debug = () => {
      const s = useGame.getState();
      return { phase: s.phase, score: s.score, timeLeft: Math.round(s.timeLeft * 10) / 10, coins: s.coins.map((c) => c.position), player: live.player, best: bestNow.current };
    };
    return () => void delete window.__debug;
  }, []);

  const start = () => {
    takeJump(); // a Space that started the round is not a jump
    sound.start();
    useGame.getState().start();
    surface.current?.focus();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Enter" && useGame.getState().phase !== "playing") start();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div ref={surface} tabIndex={-1} className="game relative h-dvh min-h-[480px] w-full overflow-hidden bg-sky-200 outline-none">
      <Canvas shadows="percentage" camera={{ position: [0, 9, 9], fov: 50 }}>
        <Sky sunPosition={[100, 40, 80]} />
        <ambientLight intensity={0.7} />
        <directionalLight castShadow position={[8, 14, 6]} intensity={1.5} shadow-mapSize={[1024, 1024]} />
        <Suspense fallback={null}>
          <Physics>
            <World />
          </Physics>
        </Suspense>
      </Canvas>

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
        <div className="flex gap-2">
          <Badge className="text-sm">Score {score}</Badge>
          <Badge variant="secondary" className="text-sm tabular-nums">{seconds}s</Badge>
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          {loaded && <Badge variant="outline" className="bg-background/80 text-sm">Best {best}</Badge>}
          <Button size="icon" variant="secondary" aria-label={muted ? "Sound on" : "Sound off"} onClick={() => setMuted(sound.toggle())}>
            {muted ? <VolumeX /> : <Volume2 />}
          </Button>
        </div>
      </div>

      {phase !== "playing" && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/20 p-4">
          <Card className="w-full max-w-sm text-center">
            <CardHeader>
              <CardTitle className="text-2xl">{phase === "over" ? `Time! ${score} coins` : "Coin rush"}</CardTitle>
              <CardDescription>
                {phase === "over" && score > 0 && score >= best ? "A new best. " : ""}
                Roll after the coins before the clock runs out.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Arrow keys or WASD to roll, Space to jump. On a phone: drag to steer, tap to jump.
            </CardContent>
            <CardFooter className="justify-center">
              <Button size="lg" onClick={start}>
                {phase === "over" ? "Play again" : "Start"}
              </Button>
            </CardFooter>
          </Card>
        </div>
      )}
    </div>
  );
}
