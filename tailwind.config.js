// @ts-check

/** @type {import('tailwindcss').Config} */
const config = {
  content: ['./index.html', './src/**/*.{js,ts,svelte}'],
  theme: {
    extend: {
      colors: {
        accent: '#d64550',
        editor: {
          background: '#f5f4f1',
          text: '#353535',
          ok: '#267940',
          busy: '#555555',
          error: '#b00020',
        },
      },
      fontFamily: {
        body: ['Charter', 'Merriweather', 'serif'],
        heading: ['Inter', '"Helvetica Neue"', 'sans-serif'],
        mono: ['Menlo', 'Consolas', 'monospace'],
      },
      lineHeight: {
        relaxed: '1.6',
        heading: '1.2',
      },
    },
  },
  plugins: [
    function ({ addBase, addUtilities, theme }) {
      const toFontStack = (value) =>
        (Array.isArray(value) ? value : [value]).join(', ');

      addBase({
        body: {
          fontFamily: toFontStack(theme('fontFamily.body')),
          lineHeight: theme('lineHeight.relaxed'),
        },
        'h1, h2, h3, h4, h5, h6': {
          fontFamily: toFontStack(theme('fontFamily.heading')),
          lineHeight: theme('lineHeight.heading'),
          fontWeight: '600',
        },
        code: {
          fontFamily: toFontStack(theme('fontFamily.mono')),
        },
      });

      addUtilities({
        '.tab-size-4': {
          'tab-size': '4',
        },
      });
    },
  ],
};

export default config;
