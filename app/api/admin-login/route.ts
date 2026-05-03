import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

// ── Admin credentials (server-side only — never exposed to the browser) ────────
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "ai-detect";
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET ?? "change-this-secret";

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json();

    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
      return NextResponse.json(
        { success: false, error: "Invalid username or password." },
        { status: 401 }
      );
    }

    // Set a secure httpOnly cookie — not readable by JavaScript
    const cookieStore = await cookies();
    cookieStore.set("admin_session", SESSION_SECRET, {
      httpOnly: true,       // JS cannot read this
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 60 * 60 * 8, // 8 hours
      path: "/",
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { success: false, error: "Server error." },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  // Sign out — clear the cookie
  const cookieStore = await cookies();
  cookieStore.delete("admin_session");
  return NextResponse.json({ success: true });
}

export async function GET() {
  // Check if admin session is valid
  const cookieStore = await cookies();
  const session = cookieStore.get("admin_session");
  const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET ?? "change-this-secret";
  const valid = session?.value === SESSION_SECRET;
  return NextResponse.json({ isAdmin: valid });
}
