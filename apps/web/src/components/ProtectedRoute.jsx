
import { Navigate, Outlet, useLocation } from 'react-router-dom'

function ProtectedRoute() {
  const token = localStorage.getItem('datagold_token')
  const location = useLocation()

  if (!token) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location }}
      />
    )
  }

  return <Outlet />
}

export default ProtectedRoute
