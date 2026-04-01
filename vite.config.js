import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// For GitHub Pages: set base to your repo name
// e.g., if your repo is github.com/you/pantry-monitor, base = '/pantry-monitor/'
// For a custom domain, set base to '/'
export default defineConfig({
  plugins: [react()],
  base: '/pantry-monitor/',
})
