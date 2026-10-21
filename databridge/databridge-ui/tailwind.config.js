/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary:  '#6366f1',
        accent:   '#06b6d4',
        success:  '#10b981',
        warning:  '#f59e0b',
        danger:   '#ef4444',
        bg:       '#f8fafc',
        surface:  '#ffffff',
        border:   '#e2e8f0',
      },
      fontFamily: {
        heading: ['Plus Jakarta Sans', 'sans-serif'],
        body:    ['Inter', 'sans-serif'],
        sans:    ['Inter', 'system-ui', 'sans-serif'],
      },
      backgroundImage: {
        'gradient-primary': 'linear-gradient(135deg, #6366f1 0%, #06b6d4 100%)',
        'gradient-light':   'linear-gradient(135deg, #f8fafc 0%, #e0e7ff 100%)',
        'gradient-card':    'linear-gradient(145deg, #ffffff 0%, #f8fafc 100%)',
      },
      boxShadow: {
        'glow':    '0 0 30px rgba(99,102,241,0.1)',
        'glow-lg': '0 0 60px rgba(99,102,241,0.15)',
        'card':    '0 2px 8px rgba(0,0,0,0.08)',
        'hover':   '0 4px 16px rgba(0,0,0,0.12)',
      },
      animation: {
        'fade-in':    'fadeInUp 0.4s ease-out both',
        'slide-left': 'slideInLeft 0.35s ease-out both',
        'float':      'float 3s ease-in-out infinite',
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
        'shimmer':    'shimmer 1.5s infinite',
      },
      borderRadius: {
        'xl':  '16px',
        '2xl': '20px',
        '3xl': '24px',
      },
    },
  },
  plugins: [],
}
