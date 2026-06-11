import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './theme.css'
import App from './App.tsx'
import { CrowdProvider } from './hooks/useCrowd.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <CrowdProvider>
        <App />
      </CrowdProvider>
    </HashRouter>
  </StrictMode>,
)
