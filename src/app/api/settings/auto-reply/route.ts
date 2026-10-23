import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    let settings = await prisma.autoReplySettings.findFirst();

    if (!settings) {
      // Create default settings if they don't exist
      settings = await prisma.autoReplySettings.create({
        data: {
          enabled: false,
          responseTone: "professional",
        },
      });
    }

    return NextResponse.json(settings);
  } catch (error) {
    console.error("Failed to fetch settings:", error);
    return NextResponse.json(
      { error: "Failed to fetch settings" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      id,
      enabled,
      autoSendToKnown,
      responseTemplate,
      responseTone,
      excludeSenders,
      excludeSubjects,
    } = body;

    let settings = await prisma.autoReplySettings.findFirst();

    if (!settings) {
      settings = await prisma.autoReplySettings.create({
        data: {
          enabled,
          autoSendToKnown,
          responseTemplate,
          responseTone,
          excludeSenders,
          excludeSubjects,
        },
      });
    } else {
      settings = await prisma.autoReplySettings.update({
        where: { id: settings.id },
        data: {
          enabled,
          autoSendToKnown,
          responseTemplate,
          responseTone,
          excludeSenders,
          excludeSubjects,
        },
      });
    }

    return NextResponse.json(settings);
  } catch (error) {
    console.error("Failed to update settings:", error);
    return NextResponse.json(
      { error: "Failed to update settings" },
      { status: 500 }
    );
  }
}
