import { MemoryRouter, NavLink, Route, Routes } from "react-router";
import { Home, Settings } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import "./styles.css";

// The pages. Each is a route; the sidebar links to them. A page that lists a
// workflow's runs reads them with `useRuns(workflow)` from "@strut/kit"; a
// button that launches one calls `useLaunch(workflow)` — on a click, never
// on a render. Grant the workflow in app.yaml first.
const PAGES = [
  { path: "/", title: "Home", icon: Home, element: <HomePage /> },
  { path: "/settings", title: "Settings", icon: Settings, element: <SettingsPage /> },
];

function HomePage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Hello</CardTitle>
        <CardDescription>Edit src/App.tsx, then app/build.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        This page is yours. Components come from <code>@/components/ui/*</code>, charts from <code>recharts</code>, data from the hooks in <code>@strut/kit</code>.
      </CardContent>
    </Card>
  );
}

function SettingsPage() {
  return <p className="text-sm text-muted-foreground">Nothing to set yet.</p>;
}

function AppSidebar() {
  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-3 text-sm font-semibold text-brand">New app</SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Pages</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {PAGES.map((p) => (
                <SidebarMenuItem key={p.path}>
                  <NavLink to={p.path} end>
                    {({ isActive }) => (
                      <SidebarMenuButton isActive={isActive}>
                        <p.icon />
                        <span>{p.title}</span>
                      </SidebarMenuButton>
                    )}
                  </NavLink>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

export default function App() {
  return (
    <MemoryRouter>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <header className="flex h-12 items-center gap-2 border-b px-4">
            <SidebarTrigger />
          </header>
          <main className="flex flex-1 flex-col gap-4 p-4">
            <Routes>
              {PAGES.map((p) => (
                <Route key={p.path} path={p.path} element={p.element} />
              ))}
            </Routes>
          </main>
        </SidebarInset>
      </SidebarProvider>
    </MemoryRouter>
  );
}
