import type { Metadata } from "next";
import "./globals.css";
import { FloatingChatButton } from "@/components/floating-chat-button";

export const metadata: Metadata = {
  title: "Inbox Archive",
  description: "Archive Gmail messages and attachments to PostgreSQL and S3.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        {children}
        <FloatingChatButton />
      </body>
    </html>
  );
}
