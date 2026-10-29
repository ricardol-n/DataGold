
import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import '../App.css'

function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const navigate = useNavigate()
  const location = useLocation()

  const successMessage = location.state?.message

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await fetch(
        `${import.meta.env.VITE_API_URL || '/api'}/auth/login`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ email, password }),
        }
      )

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.message || data.error || 'Login failed.')
      }

      // Support common token response formats.
      const accessToken =
        data.accessToken || data.token || data.data?.accessToken || data.data?.token

      if (!accessToken) {
        throw new Error(
          'Login succeeded, but no access token was returned. Check the backend response format.'
        )
      }

      // Temporary token storage for the initial frontend connection.
      localStorage.setItem('datagold_token', accessToken)

      navigate('/dashboard', { replace: true })
    } catch (err) {
      setError(err.message || 'Unable to connect to the server.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <Link to="/" className="brand">
          <span className="brand-mark">D</span>
          <span>
            Data<span className="gold-text">Gold</span>
          </span>
        </Link>

        <p className="eyebrow">WELCOME BACK</p>
        <h1>Log in to DataGold</h1>
        <p className="auth-description">
          Sign in to manage your wallet and data subscriptions.
        </p>

        {successMessage && (
          <p className="auth-success" role="status">
            {successMessage}
          </p>
        )}

        <form onSubmit={handleSubmit}>
          <label htmlFor="login-email">Email address</label>
          <input
            id="login-email"
            name="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
          />

          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            placeholder="Enter your password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />

          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}

          <button
            className="gold-button auth-submit"
            type="submit"
            disabled={loading}
          >
            {loading ? 'Signing in...' : 'Log in'}
          </button>
        </form>

        <p className="auth-switch">
          Don't have an account? <Link to="/register">Create one</Link>
        </p>

        <p className="auth-switch">
          <Link to="/">Back to home</Link>
        </p>
      </section>
    </main>
  )
}

export default Login
