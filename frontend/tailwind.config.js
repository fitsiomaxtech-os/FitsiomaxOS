/** @type {import('tailwindcss').Config} */
const twColors = require("tailwindcss/colors");

// Developer Access > Theme Appearance re-colours the whole OS by swapping CSS variables
// (see src/lib/theme.js), so every scale the boards draw with reads its shade from one.
// Background, text and border get their own variables because Dark cannot invert a shade
// the same way for all three: slate-900 text has to turn light while a slate-900 button
// behind white text has to stay dark. Each falls back to Tailwind's own value, so with no
// theme stylesheet the app is pixel-for-pixel what it was.
const THEMED_SCALES = ["slate", "gray", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan"];
const toRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};
const themedColors = (kind) => {
  const out = {};
  THEMED_SCALES.forEach((name) => {
    out[name] = {};
    Object.entries(twColors[name]).forEach(([shade, hex]) => {
      out[name][shade] = `rgb(var(--${kind}-${name}-${shade}, ${toRgb(hex)}) / <alpha-value>)`;
    });
  });
  return out;
};
const themedBg = { ...themedColors("bg"), white: "rgb(var(--bg-white, 255 255 255) / <alpha-value>)" };

module.exports = {
    darkMode: ["class"],
    content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./public/index.html"
  ],
  theme: {
  	extend: {
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)'
  		},
  		colors: {
  			background: 'hsl(var(--background))',
  			foreground: 'hsl(var(--foreground))',
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			primary: {
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--accent))',
  				foreground: 'hsl(var(--accent-foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))'
  			},
  			border: 'hsl(var(--border))',
  			input: 'hsl(var(--input))',
  			ring: 'hsl(var(--ring))',
  			chart: {
  				'1': 'hsl(var(--chart-1))',
  				'2': 'hsl(var(--chart-2))',
  				'3': 'hsl(var(--chart-3))',
  				'4': 'hsl(var(--chart-4))',
  				'5': 'hsl(var(--chart-5))'
  			}
  		},
  		backgroundColor: themedBg,
  		gradientColorStops: themedBg,
  		textColor: themedColors("tx"),
  		borderColor: themedColors("bd"),
  		divideColor: themedColors("bd"),
  		keyframes: {
  			'accordion-down': {
  				from: {
  					height: '0'
  				},
  				to: {
  					height: 'var(--radix-accordion-content-height)'
  				}
  			},
  			'accordion-up': {
  				from: {
  					height: 'var(--radix-accordion-content-height)'
  				},
  				to: {
  					height: '0'
  				}
  			},
  			// A back arrow beckoning: a quick hop left and home, then still for the rest
  			// of the beat, so it reads as "this way" rather than as a constant wobble.
  			'nudge-left': {
  				'0%, 40%, 100%': {
  					transform: 'translateX(0)'
  				},
  				'20%': {
  					transform: 'translateX(-5px)'
  				}
  			},
  			// nudge-left's mirror, for the picked summary card's corner arrow: the same hop
  			// and pause, pointing on to the list that card has opened.
  			'nudge-right': {
  				'0%, 40%, 100%': {
  					transform: 'translateX(0)'
  				},
  				'20%': {
  					transform: 'translateX(4px)'
  				}
  			},
  			// A notification dot popping up: grows from nothing past full size and settles,
  			// then sits still for the rest of a 3s beat, so it reads as a fresh alert
  			// every few seconds rather than a constant throb.
  			'dot-pop': {
  				'0%': {
  					transform: 'scale(0)'
  				},
  				'8%': {
  					transform: 'scale(1.35)'
  				},
  				'14%, 100%': {
  					transform: 'scale(1)'
  				}
  			},
  			// A clock's tick: one clockwise turn in the first half of the second, then
  			// still for the other half, so it turns once a second rather than spinning
  			// without a pause. On the + of Add Due.
  			'tick-turn': {
  				'0%': {
  					transform: 'rotate(0deg)'
  				},
  				'50%, 100%': {
  					transform: 'rotate(360deg)'
  				}
  			}
  		},
  		animation: {
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out',
  			'nudge-left': 'nudge-left 1.5s ease-in-out infinite',
  			'nudge-right': 'nudge-right 1.5s ease-in-out infinite',
  			'dot-pop': 'dot-pop 3s ease-out infinite',
  			'tick-turn': 'tick-turn 1s ease-in-out infinite'
  		}
  	}
  },
  plugins: [require("tailwindcss-animate")],
};