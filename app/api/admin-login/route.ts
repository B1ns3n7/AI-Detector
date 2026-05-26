import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();

  const validUser = process.env.ADMIN_USERNAME ?? "vincent";
  const validPass = process.env.ADMIN_PASSWORD ?? "binsent";

  if (username === validUser && password === validPass) {
    return NextResponse.json({ success: true });
  }

  return NextResponse.json(
    { success: false, error: "Invalid username or password." },
    { status: 401 }
  );
}
