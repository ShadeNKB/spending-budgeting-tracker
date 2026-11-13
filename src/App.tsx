import { BrowserRouter } from 'react-router-dom'
import { AppRoutes } from './app/RouteBoundary'
import { appRoutes } from './app/routes'
import './index.css'

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes routes={appRoutes} />
    </BrowserRouter>
  )
}
