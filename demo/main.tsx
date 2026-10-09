import { createRoot } from 'react-dom/client'
import { Watcher } from 'watcher-ui'
import { App } from './App'
import './demo.css'

createRoot(document.getElementById('root')!).render(
  <>
    <App />
    <Watcher />
  </>,
)
