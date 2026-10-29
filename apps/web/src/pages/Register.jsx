
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import '../App.css'

function Register() {
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
  })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const navigate = useNavigate()

  function handleChange(event) {
    setForm({
      ...form,
      [event.target.name]: event.target.value,
    })
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await fetch(
        `${import.meta.env.VITE_API_URL || '/api'}/auth/register`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(form),
        }
      )

      
const responseText = await response.text()

let data = {}

try {
  data = responseText ? JSON.parse(responseText) : {}
} catch {
  data = { message: responseText }
}

console.log('Registration status:', response.status)
console.log(
  'FULL REGISTRATION ERROR:',
  JSON.stringify(data, null, 2)
)

if (!response.ok) {
  throw new Error(
    data.message ||
    data.error ||
    data.errors?.[0]?.message ||
    'Registration failed. Check the backend response.'
  )
}


      setError('')
      navigate('/login', {
        state: { message: 'Account created. Please log in.' },
      })
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
          <span>Data<span className="gold-text">Gold</span></span>
        </Link>

        <p className="eyebrow">GET STARTED</p>
        <h1>Create your account</h1>
        <p className="auth-description">
          Join DataGold and manage your data subscriptions in one place.
        </p>

        <form onSubmit={handleSubmit}>
          <label htmlFor="name">Full name</label>
          <input
            id="name"
            name="name"
            type="text"
            placeholder="Enter your full name"
            value={form.name}
            onChange={handleChange}
            autoComplete="name"
            required
          />

          <label htmlFor="email">Email address</label>
          <input
            id="email"
            name="email"
            type="email"
            placeholder="you@example.com"
            value={form.email}
            onChange={handleChange}
            autoComplete="email"
            required
          />

          
<label htmlFor="password">Password</label>
<input
  id="password"
  name="password"
  type="password"
  placeholder="At least 12 characters"
  value={form.password}
  onChange={handleChange}
  autoComplete="new-password"
  minLength={12}
  required
  aria-describedby="password-help"
/>
<small id="password-help" className="password-help">
  Your password must contain at least 12 characters.
</small>


          {error && <p className="auth-error" role="alert">{error}</p>}

          <button
            className="gold-button auth-submit"
            type="submit"
            disabled={loading}
          >
            {loading ? 'Creating account...' : 'Create account'}
          </button>
        </form>

        <p className="auth-switch">
          Already have an account? <Link to="/login">Log in</Link>
        </p>
      </section>
    </main>
  )
}

export default Register
