import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { IBM_Plex_Mono, Manrope } from 'next/font/google';
import './globals.css';

const manrope = Manrope({ subsets: ['latin'], variable: '--font-sans' });
const plex = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: { default: 'Vhalcha', template: '%s · Vhalcha' },
  description: 'The AI control plane for organisations.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${manrope.variable} ${plex.variable}`}>{children}</body>
    </html>
  );
}
