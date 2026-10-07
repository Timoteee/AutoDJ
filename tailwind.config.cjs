module.exports = {
  content: ['./dj.html', './engine.js'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        signal: { DEFAULT: '#ffb3ac', light: '#ffcdc8', dark: '#e6938c' },
        flow:   { DEFAULT: '#a6e6ff', light: '#c4eeff', dark: '#7bc0d9' },
        surface: { DEFAULT: '#131313', light: '#1a1a1a', lighter: '#222222', card: '#0e0e0e', border: 'var(--border-color)', hover: '#353534' },
        amber:   { dj: '#d97706' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
        display: ['Space Grotesk', 'sans-serif'],
      },
      borderRadius: {
        'xs': '0.125rem',
        'sm': '0.25rem',
        'md': '0.5rem',
        'xl': '0.75rem',
      },
      spacing: {
        'sidebar': '16rem',
        'topbar': '4rem',
      },
    }
  }
};
