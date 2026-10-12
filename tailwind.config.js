/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f0f7ff',
          100: '#e0effe',
          200: '#bae0fd',
          300: '#7cc7fb',
          400: '#38aaf7',
          500: '#0e8ee9',
          600: '#0270c7',
          700: '#0359a1',
          800: '#074b85',
          900: '#0c3f6e',
          950: '#082849',
        },
        navy: {
          800: '#0f172a',
          850: '#0b1120',
          900: '#070c18',
          950: '#030712',
        },
        cmmc: {
          met: '#10b981',
          progress: '#f59e0b',
          notmet: '#ef4444',
          notstarted: '#64748b',
        }
      },
      // Entrance animations used across the app (animate-fadeIn / animate-scaleUp / animate-shake). They are short, and
      // "backwards" fill means the element is left with NO transform/opacity once finished (a lingering transform would
      // become the containing block of fixed-position descendants). Reduced-motion users get none of them: see index.css.
      keyframes: {
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        scaleUp: { from: { opacity: '0', transform: 'scale(0.95)' }, to: { opacity: '1', transform: 'scale(1)' } },
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%, 60%': { transform: 'translateX(-4px)' },
          '40%, 80%': { transform: 'translateX(4px)' },
        },
      },
      animation: {
        fadeIn: 'fadeIn 0.2s ease-out backwards',
        scaleUp: 'scaleUp 0.2s ease-out backwards',
        shake: 'shake 0.4s ease-in-out',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'Monaco', 'Courier New', 'monospace'],
      },
    },
  },
  plugins: [],
};
