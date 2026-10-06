import React from 'react';
import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AppHeader } from './components/AppHeader';

export const metadata: Metadata = {
  title: 'Marketplace Price Tracker & Deal Anomaly Monitor',
  description: 'Enterprise operations console for tracking marketplace deals, price anomalies, and scraping jobs',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

interface RootLayoutProps {
  children: React.ReactNode;
}

export default function RootLayout(props: RootLayoutProps) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 flex flex-col antialiased">
        <AppHeader />
        <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
          {props.children}
        </main>
      </body>
    </html>
  );
}
