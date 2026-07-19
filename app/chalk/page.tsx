import ClientApp from "../ClientApp";

export default function Page() {
  const convexUrl =
    process.env.NEXT_PUBLIC_CONVEX_URL ||
    process.env.VITE_CONVEX_URL ||
    process.env.CONVEX_URL ||
    "";

  // DEMO flag: set NEXT_PUBLIC_DEMO=off to run in showcase mode — video
  // generation is disabled (no worker/GCP needed) and the UI points visitors at
  // the already-generated gallery. Any other value (or unset) enables it.
  const generationEnabled = (process.env.NEXT_PUBLIC_DEMO ?? "").trim().toLowerCase() !== "off";

  return <ClientApp convexUrl={convexUrl} generationEnabled={generationEnabled} />;
}
