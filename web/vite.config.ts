import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Hvert byg får et id. Det bages ind i koden (__BUILD_ID__) og lægges i dist/version.json, så en
// side der har kørt længe kan se, at der er kommet en ny udgave, og genindlæse sig selv (se
// src/lib/version.ts). Uden det kunne Android-app'en køre på gammel kode i dagevis.
const BUILD_ID = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')

function versionFile(): Plugin {
  return {
    name: 'version-file',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) + '\n' })
    },
  }
}

// Deployed under aogj.com/podcast/ (one.com subfolder), so assets must resolve against /podcast/.
export default defineConfig({
  base: '/podcast/',
  plugins: [react(), versionFile()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
})
