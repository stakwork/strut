import { useState } from "react";
import { MemoryRouter, Route, Routes, Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { greet } from "./lib/greet";
import logo from "../public/logo.svg";
import "./styles.css";

function Home() {
  const [count, setCount] = useState(0);
  return (
    <main className="flex flex-col gap-4 p-6">
      <img src={logo} alt="" className="h-8 w-8" />
      <h1 className={cn("text-2xl font-semibold", count > 3 && "text-emerald-600")}>{greet("world")}</h1>
      <Badge>fixture</Badge>
      <Button onClick={() => setCount((c) => c + 1)}>Clicked {count}</Button>
      <Link to="/about" className="underline">About</Link>
    </main>
  );
}

export default function App() {
  return (
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/about" element={<p className="p-6 text-muted-foreground">About this fixture.</p>} />
      </Routes>
    </MemoryRouter>
  );
}
