import { route } from './router'
import { handleLogin, handleLogout, handleMe } from '../auth/handlers'
import { requireSession } from '../auth/middleware'

export const loginRoute = route.post('/auth/login', handleLogin)

export const logoutRoute = route.post('/auth/logout', requireSession, handleLogout)

export const meRoute = route.get('/auth/me', requireSession, handleMe)

export const routes = [loginRoute, logoutRoute, meRoute]
