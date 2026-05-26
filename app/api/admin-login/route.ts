import { NextRequest, NextResponse } from "next/server";

const VALID_USER = process.env.ADMIN_USERNAME ?? "vincent";
const VALID_PASS = process.env.ADMIN_PASSWORD ?? "binsent";

// Simple in-memory session token (resets on server restart)
let sessionToken: string | null = null;

function generateToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// GET — check existing session
export async function GET(req: NextRequest) {
  const token = req.cookies.get("admin_session")?.value;
  if (token && token === sessionToken) {
    return NextResponse.json({ isAdmin: true });
  }
  return NextResponse.json({ isAdmin: false });
}

// POST — login
export async function POST(req: NextRequest) {
  const { username, password } = await req.json();

  if (username === VALID_USER && password === VALID_PASS) {
    sessionToken = generateToken();
    const res = NextResponse.json({ success: true });
    res.cookies.set("admin_session", sessionToken, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
    return res;
  }

  return NextResponse.json(
    { success: false, error: "Invalid username or password." },
    { status: 401 }
  );
}

// DELETE — logout
export async function DELETE() {
  sessionToken = null;
  const res = NextResponse.json({ success: true });
  res.cookies.delete("admin_session");
  return res;
}