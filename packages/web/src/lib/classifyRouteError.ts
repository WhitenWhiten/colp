import { isProductApiError } from '../api'

export type RouteFailureKind = 'auth' | 'forbidden' | 'unavailable' | 'error'

export function classifyRouteError(error: unknown): RouteFailureKind {
  if (isProductApiError(error) && error.isAuthRequired) return 'auth'
  if (isProductApiError(error) && (error.status === 403 || error.code === 'insufficient_permission')) {
    return 'forbidden'
  }
  if (isProductApiError(error) && (error.status === 404 || error.code === 'resource_not_found')) {
    return 'unavailable'
  }
  return 'error'
}
