
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import '../App.css'

const API_BASE = import.meta.env.VITE_API_URL || '/api'

function formatNaira(amount) {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 2,
  }).format(Number(amount) || 0)
}

function formatDate(value) {
  if (!value) return 'Date unavailable'

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return 'Date unavailable'
  }

  return date.toLocaleString('en-NG', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function OrderHistory() {
  const navigate = useNavigate()

  const [orders, setOrders] = useState([])
  const [page, setPage] = useState(1)
  const [pagination, setPagination] = useState({
    page: 1,
    pages: 1,
    total: 0,
  })
  const [statusFilter, setStatusFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshingReference, setRefreshingReference] =
    useState('')

  const loadOrders = useCallback(async (signal) => {
    const token = localStorage.getItem('datagold_token')

    if (!token) {
      navigate('/login', { replace: true })
      return
    }

    setLoading(true)
    setError('')

    try {
      const response = await fetch(
        `${API_BASE}/data/purchase?page=${page}&limit=10`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          signal,
        }
      )

      const result = await response.json()

      if (response.status === 401 || response.status === 403) {
        localStorage.removeItem('datagold_token')
        navigate('/login', {
          replace: true,
          state: {
            message: 'Your session has expired. Please log in again.',
          },
        })
        return
      }

      if (!response.ok || result.success !== true) {
        throw new Error(
          result.message || 'Unable to load your order history.'
        )
      }

      if (!Array.isArray(result.orders)) {
        throw new Error('The server returned an invalid order list.')
      }

      setOrders(result.orders)
      setPagination(
        result.pagination || {
          page,
          pages: 1,
          total: result.orders.length,
        }
      )
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message || 'Unable to load order history.')
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false)
      }
    }
  }, [navigate, page])

  useEffect(() => {
    const controller = new AbortController()

    loadOrders(controller.signal)

    return () => controller.abort()
  }, [loadOrders])

  async function refreshOrder(reference) {
    const token = localStorage.getItem('datagold_token')

    if (!token) {
      navigate('/login', { replace: true })
      return
    }

    setRefreshingReference(reference)
    setError('')

    try {
      const response = await fetch(
        `${API_BASE}/data/purchase/${encodeURIComponent(reference)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
        }
      )

      const result = await response.json()

      if (response.status === 401 || response.status === 403) {
        localStorage.removeItem('datagold_token')
        navigate('/login', { replace: true })
        return
      }

      if (!response.ok || result.success !== true || !result.order) {
        throw new Error(
          result.message || 'Unable to retrieve this order.'
        )
      }

      // Display the status returned by the backend.
      // This lookup does not submit another purchase.
      setOrders((previous) =>
        previous.map((order) =>
          order.reference === reference
            ? { ...order, ...result.order }
            : order
        )
      )
    } catch (err) {
      setError(err.message || 'Unable to refresh order status.')
    } finally {
      setRefreshingReference('')
    }
  }

  const visibleOrders = orders.filter((order) => {
    return (
      statusFilter === 'all' ||
      String(order.status).toLowerCase() === statusFilter
    )
  })

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/dashboard">
          <span className="brand-mark">D</span>
          <span>Data<span className="gold-text">Gold</span></span>
        </a>

        <div className="sidebar-label">WORKSPACE</div>

        <nav className="side-nav" aria-label="Main navigation">
          <a className="nav-link" href="/dashboard">
            <span>⌂</span> Overview
          </a>
          <a className="nav-link" href="/dashboard#buy-data">
            <span>◈</span> Buy data
          </a>
          <a className="nav-link" href="/dashboard#wallet">
            <span>▣</span> My wallet
          </a>
          <a className="nav-link active" href="/orders">
            <span>↗</span> Order history
          </a>
        </nav>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <div className="breadcrumb">
              Workspace <span>/</span> Order history
            </div>
            <p className="topbar-subtitle">
              Track your data orders and their latest recorded status.
            </p>
          </div>

          <button
            type="button"
            className="logout-button"
            onClick={() => {
              localStorage.removeItem('datagold_token')
              navigate('/login', { replace: true })
            }}
          >
            Log out
          </button>
        </header>

        <section className="data-section order-history-page">
          <div className="section-heading">
            <div>
              <p className="eyebrow">YOUR ACTIVITY</p>
              <h2>
                Order history<span className="gold-text">.</span>
              </h2>
              <p className="section-description">
                Review your data orders, recipients, references and statuses.
              </p>
            </div>

            <button
              type="button"
              className="gold-button"
              disabled={loading}
              onClick={() => loadOrders()}
            >
              {loading ? 'Loading...' : 'Refresh history ↻'}
            </button>
          </div>

          <div className="order-history-toolbar">
            <label htmlFor="order-status-filter">
              Filter by status
            </label>

            <select
              id="order-status-filter"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">All orders</option>
              <option value="pending">Pending</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
            </select>

            <span>
              {pagination.total ?? orders.length} total orders
            </span>
          </div>

          {error && (
            <div className="notice" role="alert">
              <p>{error}</p>
              <button
                type="button"
                onClick={() => loadOrders()}
              >
                Retry
              </button>
            </div>
          )}

          {loading ? (
            <p className="transaction-message">
              Loading your order history...
            </p>
          ) : !error && visibleOrders.length === 0 ? (
            <div className="order-history-empty">
              <h3>No orders found</h3>
              <p>
                {orders.length === 0
                  ? 'Your data orders will appear here when they are recorded.'
                  : 'No orders match this status filter.'}
              </p>

              <button
                type="button"
                className="gold-button"
                onClick={() => navigate('/dashboard#buy-data')}
              >
                Browse data plans →
              </button>
            </div>
          ) : (
            <div className="transaction-table order-history-table">
              <div className="transaction-header">
                <span>ORDER DETAILS</span>
                <span>STATUS</span>
                <span>AMOUNT</span>
              </div>

              {visibleOrders.map((order) => {
                const status = String(order.status || 'pending')
                  .toLowerCase()

                return (
                  <article
                    className="transaction-row order-history-row"
                    key={order.reference}
                  >
                    <div className="transaction-name">
                      <span className="transaction-icon data_purchase">
                        ◈
                      </span>

                      <span className="order-history-details">
                        <strong>
                          {order.network
                            ? `${order.network.toUpperCase()} data`
                            : order.description || 'Data purchase'}
                        </strong>

                        <small>{order.plan || order.description || 'Data plan'}</small>
                        <small>Recipient: {order.phone || 'Unavailable'}</small>
                        <small>{formatDate(order.createdAt)}</small>
                        <small className="order-reference">
                          Ref: {order.reference}
                        </small>
                      </span>
                    </div>

                    <div className="order-history-status">
                      <span
                        className={`transaction-status ${
                          status === 'completed'
                            ? 'completed'
                            : status === 'pending'
                              ? 'pending'
                              : status === 'failed'
                                ? 'failed'
                                : ''
                        }`}
                      >
                        {status.charAt(0).toUpperCase() + status.slice(1)}
                      </span>

                      {status === 'pending' && (
                        <button
                          type="button"
                          className="order-refresh-button"
                          disabled={
                            refreshingReference === order.reference
                          }
                          onClick={() => refreshOrder(order.reference)}
                        >
                          {refreshingReference === order.reference
                            ? 'Checking...'
                            : 'Check status ↻'}
                        </button>
                      )}
                    </div>

                    <strong className="muted-amount">
                      {formatNaira(order.amount)}
                    </strong>
                  </article>
                )
              })}
            </div>
          )}

          <div className="order-history-pagination">
            <button
              type="button"
              disabled={loading || page <= 1}
              onClick={() => setPage((current) => current - 1)}
            >
              ← Previous
            </button>

            <span>
              Page {pagination.page || page} of{' '}
              {Math.max(1, pagination.pages || 1)}
            </span>

            <button
              type="button"
              disabled={
                loading || page >= (pagination.pages || 1)
              }
              onClick={() => setPage((current) => current + 1)}
            >
              Next →
            </button>
          </div>
        </section>

        <footer className="footer">
          <a className="footer-brand" href="/dashboard">
            Data<span className="gold-text">Gold</span>
          </a>
          <span>Simple connections. Smarter living.</span>
          <span>© {new Date().getFullYear()} DataGold</span>
        </footer>
      </main>
    </div>
  )
}

export default OrderHistory
