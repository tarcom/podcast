import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Deployed under aogj.com/podcast/ (one.com subfolder), so assets must resolve against /podcast/.
export default defineConfig({
  base: '/podcast/',
  plugins: [react()],
})
