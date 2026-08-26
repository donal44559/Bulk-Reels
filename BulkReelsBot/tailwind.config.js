/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg:      '#0b1220',
        panel:   '#0f1a2e',
        card:    '#132241',
        card2:   '#0e1a34',
        border:  '#1e3a63',
        border2: '#254a7a',
        text:    '#e6edf5',
        muted:   '#8ca0b8',
        cyanx:   '#22d3ee',
        pinkx:   '#f472b6',
        greenx:  '#34d399',
        redx:    '#f43f5e',
        orangex: '#f59e0b',
        purplex: '#a78bfa',
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(34,211,238,0.35), 0 0 24px rgba(34,211,238,0.15)',
      },
    },
  },
  plugins: [],
};
