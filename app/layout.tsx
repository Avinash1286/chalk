import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Whiteboard Studio — AI explainer video generator",
  description:
    "Turn a one-line prompt into a narrated, hand-drawn whiteboard explainer video, scene by scene.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
