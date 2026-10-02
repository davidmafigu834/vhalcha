import { NextResponse, type NextRequest } from 'next/server';

const publicPaths = ['/sign-in', '/forgot-password', '/reset-password'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get('vh_session')?.value;
  const isPublic = publicPaths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
  const headers = new Headers(request.headers);
  headers.set('x-pathname', pathname);
  if (!token && !isPublic) {
    return NextResponse.redirect(new URL('/sign-in', request.url));
  }
  if (token && (pathname === '/' || pathname === '/sign-in')) {
    return NextResponse.redirect(new URL('/overview', request.url));
  }
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
