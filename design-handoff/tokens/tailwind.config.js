/**
 * APIStend — конфигурация Tailwind CSS v3.
 * Для Tailwind v4 этот файл не нужен: используйте блок @theme из tokens.css.
 * Значения синхронизированы с tokens.json и переменными в APIStend.pen.
 */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,vue,html}'],
  theme: {
    extend: {
      colors: {
        bg: '#F6F7F9',
        surface: { DEFAULT: '#FFFFFF', 2: '#F1F3F7', 3: '#E9ECF2' },
        nav: { bg: '#0D1218', bg2: '#161D26', text: '#9AA6B6', active: '#FFFFFF' },
        border: { DEFAULT: '#E4E8EE', strong: '#CDD5E0' },
        text: { primary: '#0D1218', secondary: '#5A6675', tertiary: '#8B96A5' },
        accent: { DEFAULT: '#3B54F5', hover: '#2A41D6', soft: '#ECEFFE' },
        success: { DEFAULT: '#14804A', soft: '#E4F5EC' },
        warning: { DEFAULT: '#B26205', soft: '#FCF0DF' },
        danger: { DEFAULT: '#C22B2B', soft: '#FBEAEA' },
        info: { DEFAULT: '#0B7FA8', soft: '#E2F2F8' },
        code: {
          bg: '#0D1218',
          surface: '#151C25',
          text: '#D5DCE6',
          key: '#7FB3FF',
          string: '#8FD69B',
          number: '#E5B86B',
          muted: '#5C6A7A',
          template: '#C79BF2',
        },
        brand: { bitrix: '#1FA9E0', ozon: '#005BFF', wb: '#A4139E' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      borderRadius: { sm: '6px', md: '10px', lg: '14px', pill: '20px' },
      spacing: { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '24px', 6: '32px' },
      maxWidth: { screen: '1440px' },
      width: { sidebar: '248px' },
      height: { topbar: '64px' },
    },
  },
  plugins: [],
};
