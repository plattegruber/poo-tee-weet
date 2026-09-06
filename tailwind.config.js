// @ts-check

// Design tokens for poo-tee-weet: oat paper, plum-cast ink, one plum accent.
// Literata is the voice (titles, prose), Public Sans is the interface, IBM Plex
// Mono is for tags and counts only.

const palette = {
  paper: { 0: '#F7F2E9', 1: '#F1EBDF', 2: '#E8E0D1', 3: '#DBD1BF' },
  ink: { 0: '#1E1A1F', 1: '#3A343B', 2: '#6B636C', 3: '#9B929B', 4: '#C4BBBF' },
  plum: { 1: '#E9DCEB', 3: '#A97FB2', 5: '#6E3E78', 7: '#4E2A56', 9: '#2F1A33' },
  moss: { 1: '#DCE5D6', 5: '#4F6B4A' },
  rust: { 1: '#F0DBD2', 5: '#9E4A33' },
  gold: { 1: '#F2E6C4', 5: '#A3781C' },
};

/** @type {import('tailwindcss').Config} */
const config = {
  content: ['./index.html', './src/**/*.{js,ts,svelte}'],
  theme: {
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      ...palette,
      surface: {
        page: palette.paper[0],
        raised: palette.paper[1],
        sunken: palette.paper[2],
        inverse: palette.ink[0],
      },
      text: {
        body: palette.ink[0],
        muted: palette.ink[2],
        faint: palette.ink[3],
        inverse: palette.paper[0],
        accent: palette.plum[5],
      },
      accent: {
        DEFAULT: palette.plum[5],
        hover: palette.plum[7],
        active: palette.plum[9],
        soft: palette.plum[1],
        on: palette.paper[0],
      },
      border: {
        subtle: palette.paper[3],
        strong: palette.ink[4],
        focus: palette.plum[5],
      },
      success: { DEFAULT: palette.moss[5], soft: palette.moss[1] },
      danger: { DEFAULT: palette.rust[5], soft: palette.rust[1] },
      warning: { DEFAULT: palette.gold[5], soft: palette.gold[1] },
      selection: 'rgba(110, 62, 120, 0.18)',
      scrim: 'rgba(30, 26, 31, 0.45)',
    },
    fontFamily: {
      display: ['Literata', 'Georgia', '"Times New Roman"', 'serif'],
      prose: ['Literata', 'Georgia', '"Times New Roman"', 'serif'],
      ui: ['"Public Sans"', 'system-ui', '-apple-system', 'sans-serif'],
      mono: ['"IBM Plex Mono"', 'ui-monospace', 'Menlo', 'monospace'],
    },
    fontSize: {
      xs: '12px',
      sm: '13px',
      md: '15px',
      lg: '18px',
      prose: '20px',
      xl: '24px',
      '2xl': '32px',
      '3xl': '44px',
      '4xl': '60px',
    },
    lineHeight: {
      none: '1',
      tight: '1.15',
      snug: '1.3',
      normal: '1.5',
      prose: '1.65',
    },
    letterSpacing: {
      tight: '-0.015em',
      normal: '0',
      wide: '0.06em',
    },
    fontWeight: {
      light: '300',
      regular: '400',
      medium: '500',
      semibold: '600',
    },
    borderRadius: {
      none: '0',
      sm: '3px',
      md: '6px',
      lg: '10px',
      pill: '999px',
      full: '50%',
    },
    boxShadow: {
      none: 'none',
      sm: '0 1px 2px rgba(30, 26, 31, 0.06)',
      md: '0 2px 8px rgba(30, 26, 31, 0.08), 0 1px 2px rgba(30, 26, 31, 0.05)',
      lg: '0 12px 32px rgba(30, 26, 31, 0.14), 0 2px 6px rgba(30, 26, 31, 0.06)',
      focus: `0 0 0 2px ${palette.paper[0]}, 0 0 0 4px ${palette.plum[5]}`,
    },
    transitionDuration: {
      fast: '120ms',
      base: '200ms',
      slow: '400ms',
    },
    transitionTimingFunction: {
      out: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
      'in-out': 'cubic-bezier(0.6, 0, 0.2, 1)',
    },
    extend: {
      spacing: {
        // 4px base scale: 4 8 12 16 24 32 48 64 96
        'control-sm': '28px',
        'control-md': '36px',
        'control-lg': '44px',
        bar: '52px',
      },
      maxWidth: {
        prose: '38rem',
        list: '640px',
        dialog: '420px',
        form: '320px',
      },
    },
  },
  plugins: [
    function ({ addBase, addUtilities, theme }) {
      const toFontStack = (value) => (Array.isArray(value) ? value : [value]).join(', ');

      addBase({
        '*, *::before, *::after': { boxSizing: 'border-box' },
        html: {
          WebkitFontSmoothing: 'antialiased',
          textRendering: 'optimizeLegibility',
        },
        body: {
          margin: '0',
          background: theme('colors.surface.page'),
          color: theme('colors.text.body'),
          fontFamily: toFontStack(theme('fontFamily.ui')),
          fontSize: theme('fontSize.md'),
          lineHeight: theme('lineHeight.normal'),
        },
        '::selection': { background: theme('colors.selection') },
        a: {
          color: theme('colors.text.accent'),
          textDecoration: 'underline',
          textDecorationThickness: '1px',
          textUnderlineOffset: '2px',
          transition: `color ${theme('transitionDuration.fast')} ${theme('transitionTimingFunction.out')}`,
        },
        'a:hover': { color: theme('colors.accent.hover') },
        ':focus-visible': {
          outline: 'none',
          boxShadow: theme('boxShadow.focus'),
        },
        code: { fontFamily: toFontStack(theme('fontFamily.mono')) },
      });

      addUtilities({
        '.tab-size-4': { 'tab-size': '4' },
      });
    },
  ],
};

export default config;
