'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';

interface NavLink {
  href: string;
  label: string;
}

const NAV_LINKS: NavLink[] = [
  { href: '/', label: 'Deals & Anomalies' },
  { href: '/searches', label: 'Tracked Searches' },
  { href: '/listings', label: 'Listings Explorer' },
  { href: '/jobs', label: 'Scrape Jobs' },
];

export function AppHeader() {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  // Handle ESC key to close mobile menu and return focus
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && mobileMenuOpen) {
        setMobileMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    }

    if (mobileMenuOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [mobileMenuOpen]);

  function renderDesktopNavLink(link: NavLink) {
    const isActive =
      link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
    const linkClass = isActive
      ? 'px-3 py-2 text-sm font-semibold text-slate-900 border-b-2 border-slate-900 focus-visible:outline-2 focus-visible:outline-slate-900 rounded-t'
      : 'px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-800 border-b-2 border-transparent hover:border-slate-300 focus-visible:outline-2 focus-visible:outline-slate-900 rounded-t';

    return (
      <Link
        key={link.href}
        href={link.href}
        className={linkClass}
        aria-current={isActive ? 'page' : undefined}
      >
        {link.label}
      </Link>
    );
  }

  function renderMobileNavLink(link: NavLink) {
    const isActive =
      link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
    const linkClass = isActive
      ? 'block px-3 py-2.5 text-sm font-semibold text-slate-900 bg-slate-100 rounded-md border-l-4 border-slate-900 focus-visible:outline-2 focus-visible:outline-slate-900'
      : 'block px-3 py-2.5 text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-50 rounded-md border-l-4 border-transparent focus-visible:outline-2 focus-visible:outline-slate-900';

    return (
      <Link
        key={link.href}
        href={link.href}
        className={linkClass}
        onClick={() => setMobileMenuOpen(false)}
        aria-current={isActive ? 'page' : undefined}
      >
        {link.label}
      </Link>
    );
  }

  const desktopNavItems = NAV_LINKS.map(renderDesktopNavLink);
  const mobileNavItems = NAV_LINKS.map(renderMobileNavLink);

  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-14">
          {/* Logo / Brand */}
          <div className="flex items-center space-x-3 sm:space-x-8 min-w-0">
            <Link
              href="/"
              className="flex items-center space-x-2 min-w-0 focus-visible:outline-2 focus-visible:outline-slate-900 rounded py-1"
              aria-label="Price Tracker Operations Home"
            >
              <span className="font-mono font-bold text-xs sm:text-sm tracking-wider uppercase text-slate-900 truncate">
                PRICE TRACKER <span className="hidden sm:inline">// OPERATIONS</span>
              </span>
              <span className="text-[10px] sm:text-xs px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded font-mono shrink-0">
                v1.0
              </span>
            </Link>

            {/* Desktop Navigation Links (>= lg screens) */}
            <nav
              className="hidden lg:flex space-x-2"
              aria-label="Main navigation"
            >
              {desktopNavItems}
            </nav>
          </div>

          {/* Desktop Right Status (>= lg screens) */}
          <div className="hidden lg:flex items-center space-x-4 text-xs font-mono text-slate-500">
            <span>SQLITE: WAL</span>
            <span
              className="w-1.5 h-1.5 rounded-full bg-emerald-500"
              title="Database Status: Operational"
              aria-hidden="true"
            ></span>
          </div>

          {/* Mobile Menu Hamburger Button (< lg screens) */}
          <div className="flex items-center lg:hidden">
            <button
              ref={menuButtonRef}
              type="button"
              onClick={() => setMobileMenuOpen((prev) => !prev)}
              aria-expanded={mobileMenuOpen}
              aria-controls="mobile-navigation"
              aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
              className="lg:hidden p-2 rounded-md text-slate-700 hover:text-slate-900 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 transition-colors"
            >
              {mobileMenuOpen ? (
                <X className="w-5 h-5" aria-hidden="true" />
              ) : (
                <Menu className="w-5 h-5" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        {/* Mobile Navigation Dropdown (< lg screens) */}
        {mobileMenuOpen && (
          <nav
            id="mobile-navigation"
            aria-label="Mobile navigation"
            className="lg:hidden border-t border-slate-200 py-3 space-y-1 bg-white"
          >
            {mobileNavItems}
            <div className="pt-2.5 mt-2 border-t border-slate-100 flex items-center justify-between px-3 text-xs font-mono text-slate-500">
              <span>SQLITE: WAL</span>
              <span className="flex items-center space-x-1.5">
                <span
                  className="w-1.5 h-1.5 rounded-full bg-emerald-500"
                  aria-hidden="true"
                ></span>
                <span className="text-[11px] text-emerald-600 font-medium">ONLINE</span>
              </span>
            </div>
          </nav>
        )}
      </div>
    </header>
  );
}
