import { useState,useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import '../App.css'

const networks = [
  { id: 'MTN', name: 'MTN', color: '#ffcc00', symbol: 'M' },
  { id: 'Airtel', name: 'Airtel', color: '#f04452', symbol: 'A' },
  { id: 'Glo', name: 'Glo', color: '#21c66b', symbol: 'G' },
  { id: '9mobile', name: '9mobile', color: '#087f5b', symbol: '9' }
]



function formatNaira(amount) {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 2,
  }).format(amount)
}


function Dashboard() {
  const [selectedNetwork, setSelectedNetwork] = useState('MTN')
  const [selectedBundle, setSelectedBundle] = useState(null)
  const [showBalance, setShowBalance] = useState(true)
  const [notice, setNotice] = useState('')
  const [walletBalance, setWalletBalance] = useState(null)
const [walletLoading, setWalletLoading] = useState(true)
const [walletError, setWalletError] = useState('')
const [showFundModal, setShowFundModal] = useState(false)
const [fundAmount, setFundAmount] = useState('100')
const [funding, setFunding] = useState(false)
const [fundError, setFundError] = useState('')
const [walletTransactions, setWalletTransactions] = useState([])
const [transactionsLoading, setTransactionsLoading] = useState(true)
const [transactionsError, setTransactionsError] = useState('')
const [transactionsRefresh, setTransactionsRefresh] = useState(0)
const [dataPlans, setDataPlans] = useState([])
const [plansLoading, setPlansLoading] = useState(false)
const [plansError, setPlansError] = useState('')
const [recipientPhone, setRecipientPhone] = useState('')
const [planSearch, setPlanSearch] = useState('')
const [appliedPlanSearch, setAppliedPlanSearch] = useState('')
const [showPurchaseStep, setShowPurchaseStep] = useState(false)
  const navigate = useNavigate()


function handleLogout() {
  localStorage.removeItem('datagold_token')
  navigate('/login', { replace: true })
}

  
function handleFundWallet() {
  setFundError('')
  setNotice('')
  setFundAmount('100')
  setShowFundModal(true)
}

async function handleSubmitFundWallet(event) {
  event.preventDefault()
  setFundError('')

  const amount = Number(fundAmount)

  if (
    !Number.isSafeInteger(amount) ||
    amount < 100 ||
    amount > 5000000
  ) {
    setFundError(
      'Enter a whole amount between ₦100 and ₦5,000,000.'
    )
    return
  }

  const token = localStorage.getItem('datagold_token')

  if (!token) {
    navigate('/login', { replace: true })
    return
  }

  try {
    setFunding(true)

    const response = await fetch(
      `${import.meta.env.VITE_API_URL || '/api'}/wallet/fund`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ amount }),
      }
    )

    const data = await response.json()

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

    if (!response.ok || !data.success) {
      throw new Error(
        data.message || 'Unable to start wallet funding.'
      )
    }

    if (!data.payment?.authorizationUrl) {
      throw new Error('Paystack did not return a checkout URL.')
    }

    // Redirect to the official Paystack checkout page.
    window.location.assign(data.payment.authorizationUrl)
  } catch (error) {
    setFundError(
      error.message || 'Unable to connect to the payment server.'
    )
  } finally {
    setFunding(false)
  }
}


  
function handleBuyData() {
  if (!selectedBundle) {
    setNotice('Please select a data bundle first.')
    return
  }

  if (!/^\d{11}$/.test(recipientPhone)) {
    setNotice('Enter a valid 11-digit Nigerian phone number.')
    return
  }

  setNotice(
    `Order review: ${selectedNetwork}, ${selectedBundle.data}, ` +
    `${formatNaira(selectedBundle.price)} for ${recipientPhone}. ` +
    'Purchases are temporarily disabled while provider access is verified.'
  )
}


  
useEffect(() => {
  const controller = new AbortController()

  async function fetchWallet() {
    const token = localStorage.getItem('datagold_token')

    if (!token) {
      navigate('/login', { replace: true })
      return
    }

    try {
      setWalletLoading(true)
      setWalletError('')

      const response = await fetch(
        `${import.meta.env.VITE_API_URL || '/api'}/wallet`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          signal: controller.signal,
        }
      )

      const data = await response.json()

      if (response.status === 401 || response.status === 403) {
        localStorage.removeItem('datagold_token')
        navigate('/login', {
          replace: true,
          state: { message: 'Your session has expired. Please log in again.' },
        })
        return
      }

      if (!response.ok || data.success === false) {
        throw new Error(data.message || 'Unable to load your wallet.')
      }

      const rawBalance =
  data.wallet?.balance ??
  data.balance ??
  data.data?.wallet?.balance ??
  data.data?.balance

const balance = Number(rawBalance)

      if (!Number.isFinite(balance)) {
        throw new Error('The server returned an invalid wallet balance.')
      }

      setWalletBalance(balance)
    } catch (error) {
      if (error.name !== 'AbortError') {
        setWalletError(error.message || 'Unable to connect to the server.')
      }
    } finally {
      if (!controller.signal.aborted) {
        setWalletLoading(false)
      }
    }
  }

  fetchWallet()

  return () => controller.abort()
}, [navigate])


useEffect(() => {
  const params = new URLSearchParams(window.location.search)
  const reference = params.get('reference') || params.get('trxref')

  if (!reference) return

  let cancelled = false

  async function verifyPayment() {
    const token = localStorage.getItem('datagold_token')

    if (!token) {
      navigate('/login', { replace: true })
      return
    }

    try {
      setNotice('Verifying your payment with Paystack...')

      const response = await fetch(
        `${import.meta.env.VITE_API_URL || '/api'}/wallet/fund/verify`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ reference }),
        }
      )

      const data = await response.json()

      if (!response.ok || !data.success) {
        throw new Error(
          data.message || 'Payment verification failed.'
        )
      }

      const balance = Number(data.wallet?.balance)

      if (!Number.isFinite(balance)) {
        throw new Error('The server returned an invalid wallet balance.')
      }

      if (cancelled) return

      setWalletBalance(balance)
      setWalletError('')
      setNotice(data.message || 'Wallet funded successfully.')
      setTransactionsRefresh((previous) => previous + 1)

      // Remove payment reference after successful verification.
      window.history.replaceState(
        {},
        document.title,
        window.location.pathname + window.location.hash
      )
    } catch (error) {
      if (!cancelled) {
        setNotice(
          `Payment verification: ${error.message} If you completed payment, retry verification before making another deposit.`
        )
      }
    }
  }

  verifyPayment()

  return () => {
    cancelled = true
  }
}, [navigate])


useEffect(() => {
  const controller = new AbortController()

  async function fetchTransactions() {
    const token = localStorage.getItem('datagold_token')

    if (!token) {
      setTransactionsLoading(false)
      navigate('/login', { replace: true })
      return
    }

    try {
      setTransactionsLoading(true)
      setTransactionsError('')

      const response = await fetch(
        `${import.meta.env.VITE_API_URL || '/api'}/wallet/transactions?limit=5`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          signal: controller.signal,
        }
      )

      const data = await response.json()

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

      if (!response.ok || data.success !== true) {
        throw new Error(
          data.message || 'Unable to load transaction history.'
        )
      }

      if (!Array.isArray(data.transactions)) {
        throw new Error('Invalid transaction history response.')
      }

      setWalletTransactions(data.transactions)
    } catch (error) {
      if (error.name !== 'AbortError') {
        setTransactionsError(
          error.message || 'Unable to load transactions.'
        )
      }
    } finally {
      if (!controller.signal.aborted) {
        setTransactionsLoading(false)
      }
    }
  }

  fetchTransactions()

  return () => controller.abort()
}, [navigate, transactionsRefresh])

useEffect(() => {
  const controller = new AbortController()

  const networkMap = {
    MTN: 'mtn',
    Airtel: 'airtel',
    Glo: 'glo',
    '9mobile': '9mobile',
  }

  async function loadDataPlans() {
    const network = networkMap[selectedNetwork]

    setDataPlans([])
    setSelectedBundle(null)
    setShowPurchaseStep(false)
    setPlansError('')

    if (!network) {
      setPlansLoading(false)
      setPlansError('This network is not supported yet.')
      return
    }

    const token = localStorage.getItem('datagold_token')

    if (!token) {
      setPlansLoading(false)
      navigate('/login', { replace: true })
      return
    }

    setPlansLoading(true)

    try {
      const API_BASE = import.meta.env.VITE_API_URL || '/api'

      const response = await fetch(
        `${API_BASE}/data/plans?network=${encodeURIComponent(network)}`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
          },
          signal: controller.signal,
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
          result.message || 'Unable to load data plans.'
        )
      }

      if (!Array.isArray(result.plans)) {
        throw new Error('The provider returned an invalid plans list.')
      }

      const plans = result.plans
        .map((plan) => ({
          id: plan.code,
          code: plan.code,
          data: plan.description,
          validity: '',
          price: Number(plan.price),
        }))
        .filter(
          (plan) =>
            typeof plan.code === 'string' &&
            plan.code.length > 0 &&
            typeof plan.data === 'string' &&
            plan.data.length > 0 &&
            Number.isFinite(plan.price) &&
            plan.price > 0
        )

      setDataPlans(plans)

      if (plans.length === 0) {
        setPlansError(
          'No valid data plans are currently available for this network.'
        )
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        setPlansError(
          error.message || 'Unable to load data plans.'
        )
      }
    } finally {
      if (!controller.signal.aborted) {
        setPlansLoading(false)
      }
    }
  }

  loadDataPlans()

  return () => controller.abort()
}, [selectedNetwork, navigate])

const filteredDataPlans = dataPlans.filter((plan) => {
  const query = appliedPlanSearch.trim().toLowerCase()

  if (!query) return true

  const searchableText = [
    plan.data,
    plan.code,
    plan.price,
    plan.validity,
  ].join(' ').toLowerCase()

  // Let users search "1GB" or "1 GB".
  const normalizedQuery = query.replace(/\s+/g, '')

  return (
    searchableText.includes(query) ||
    searchableText.replace(/\s+/g, '').includes(normalizedQuery)
  )
})

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#home" aria-label="DataGold home">
          <span className="brand-mark">D</span>
          <span>Data<span className="gold-text">Gold</span></span>
        </a>

        <div className="sidebar-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          <a className="nav-link active" href="#home"><span>⌂</span> Overview</a>
          <a className="nav-link" href="#buy-data"><span>◈</span> Buy data</a>
          <a className="nav-link" href="#wallet"><span>▣</span> My wallet</a>
          <a className="nav-link" href="/orders"><span>↗</span> Transactions</a>
        </nav>

        <div className="sidebar-bottom">
          <div className="help-card">
            <span className="help-icon">✦</span>
            <strong>Need a hand?</strong>
            <p>We're here to help you stay connected.</p>
            <a href="mailto:support@datagold.com">Contact support ↗</a>
          </div>
          <div className="profile-row">
            <div className="avatar">DG</div>
            <div className="profile-copy">
              <strong>DataGold User</strong>
              <span>Personal account</span>
            </div>
            <span className="profile-menu">•••</span>
          </div>
        </div>
      </aside>

      <main className="main-content" id="home">
        <header className="topbar">
          <div>
            <div className="breadcrumb">Workspace <span>/</span> Overview</div>
            <p className="topbar-subtitle">Your connection, made simple.</p>
          </div>
          <div className="topbar-actions">
            <span className="status-dot" />
            <span className="secure-label">Secure account</span>
            <button
  type="button"
  className="logout-button"
  onClick={handleLogout}
>
  Log out
</button>
            <button
              className="icon-button notification-button"
              type="button"
              aria-label="Notifications"
              onClick={() => setNotice('You are all caught up.')}
            >
              ♧
            </button>
          </div>
        </header>

        <section className="welcome-section">
          <div>
            <p className="eyebrow"><span className="eyebrow-line" /> YOUR DIGITAL LIFESTYLE</p>
            <h1>Good day, <span className="gold-text">welcome back.</span></h1>
            <p className="welcome-copy">Manage your wallet and stay connected, all in one place.</p>
          </div>
          <div className="welcome-orb" aria-hidden="true">
            <div className="orb-ring ring-one" />
            <div className="orb-ring ring-two" />
            <div className="orb-core">D<span>.</span></div>
          </div>
        </section>

        <section className="overview-grid" id="wallet">
          <article className="balance-card">
            <div className="balance-card-glow" />
            <div className="balance-top">
              <div className="balance-label"><span className="wallet-symbol">▣</span> TOTAL WALLET BALANCE</div>
              <span className="balance-chip"><span /> NGN WALLET</span>
            </div>
            
<div className="balance-amount">
  <span>
    {!showBalance
      ? '••••••••'
      : walletLoading
        ? 'Loading...'
        : walletError
          ? 'Unavailable'
          : formatNaira(walletBalance)}
  </span>

  <button
    className="eye-button"
    type="button"
    onClick={() => setShowBalance((previous) => !previous)}
    aria-label={showBalance ? 'Hide wallet balance' : 'Show wallet balance'}
  >
    {showBalance ? '◉' : '◎'}
  </button>
</div>

<p className="balance-note">
  {walletError
    ? 'Your wallet balance could not be loaded.'
    : 'Available for your next purchase'}
</p>

{walletError && (
  <p className="auth-error" role="alert">
    {walletError}
  </p>
)}

            <p className="balance-note">Available for your next purchase</p>
            <div className="balance-divider" />
            <div className="balance-bottom">
              <div><span className="mini-label">ACCOUNT STATUS</span><strong><span className="status-dot" /> Active</strong></div>
              <button className="gold-button" type="button" onClick={handleFundWallet}>
                + Add money <span>↗</span>
              </button>
            </div>
          </article>

          <article className="quick-card">
            <div className="card-heading">
              <div><p className="eyebrow">QUICK ACCESS</p><h2>What would you like to do?</h2></div>
              <span className="heading-spark">✳</span>
            </div>
            <div className="quick-actions">
              <a className="quick-action" href="#buy-data">
                <span className="quick-icon purple-icon">◈</span>
                <strong>Buy data</strong>
                <span className="action-arrow">↗</span>
              </a>
              <button className="quick-action" type="button" onClick={handleFundWallet}>
                <span className="quick-icon gold-icon">＋</span>
                <strong>Fund wallet</strong>
                <span className="action-arrow">↗</span>
              </button>
              <a className="quick-action" href="#transactions">
                <span className="quick-icon green-icon">↗</span>
                <strong>History</strong>
                <span className="action-arrow">↗</span>
              </a>
            </div>
            <p className="quick-footnote"><span>✦</span> Fast, simple and secure transactions.</p>
          </article>
        </section>

        {notice && (
          <div className="notice" role="status">
            <span>✦</span>
            <p>{notice}</p>
            <button type="button" onClick={() => setNotice('')} aria-label="Dismiss message">×</button>
          </div>
        )}

        <section className="data-section" id="buy-data">
          <div className="section-heading">
            <div>
              <p className="eyebrow">STAY CONNECTED</p>
              <h2>Buy data bundles<span className="gold-text">.</span></h2>
              <p className="section-description">Choose your network and find the right plan for you.</p>
            </div>
            <span className="section-count">03 NETWORKS</span>
          </div>

          <div className="network-grid">
            {networks.map((network) => (
              <button
                type="button"
                key={network.id}
                className={`network-card ${selectedNetwork === network.id ? 'selected' : ''}`}
                onClick={() => {
                  setSelectedNetwork(network.id)
                    setSelectedBundle(null)
                    setShowPurchaseStep(false)
                    setRecipientPhone('')
                    setNotice('')
                }}
                style={{ '--network-color': network.color }}
                aria-pressed={selectedNetwork === network.id}
              >
                <span className="network-logo">{network.symbol}</span>
                <span className="network-info"><strong>{network.name}</strong><small>Data bundles</small></span>
                <span className="network-check">{selectedNetwork === network.id ? '✓' : '↗'}</span>
              </button>
            ))}
          </div>

          <div className="bundle-heading">
            <div><h3>{selectedNetwork} data plans</h3><p>Select a bundle to continue.</p></div>
            <span className="plan-badge">POPULAR PLANS</span>
          </div>
          
<form
  className="plan-search"
  onSubmit={(event) => {
    event.preventDefault()
    setAppliedPlanSearch(planSearch)
  }}
>
  <div className="plan-search-input-wrap">
    <span className="plan-search-icon" aria-hidden="true">⌕</span>
    <input
      type="search"
      value={planSearch}
      onChange={(event) => setPlanSearch(event.target.value)}
      placeholder="Search plans: 1GB, 5GB, Daily, Weekly..."
      aria-label="Search data plans"
    />
    {planSearch && (
      <button
        type="button"
        className="plan-search-clear"
        onClick={() => {
          setPlanSearch('')
          setAppliedPlanSearch('')
        }}
        aria-label="Clear search"
      >
        ×
      </button>
    )}
  </div>

  <button className="gold-button plan-search-button" type="submit">
    Search
  </button>
</form>


          
<div className="bundle-grid">
  {plansLoading ? (
    <p className="plans-message">
      Loading available data plans...
    </p>
  ) : plansError ? (
    <p className="plans-message plans-error">
      {plansError}
    </p>
  ) : filteredDataPlans.length === 0 ? (
    <p className="plans-message">
  {dataPlans.length === 0
    ? 'No plans available right now. Please try again later.'
    : 'No plans match your search. Try another size or keyword.'}
</p>
  ) : (
    <>
      <div className="plans-table-header">
        <span>DATA PLAN</span>
        <span>VALIDITY</span>
        <span>PRICE</span>
        <span>SELECT</span>
      </div>

      <div className="plans-scroll">
        {filteredDataPlans.map((bundle) => (
          <button
            type="button"
            key={bundle.id}
            className={`plan-row ${
              selectedBundle?.id === bundle.id
                ? 'plan-row-selected'
                : ''
            }`}
           onClick={() => {
  setSelectedBundle(bundle)
  setShowPurchaseStep(true)
  setRecipientPhone('')
  setNotice('')

  setTimeout(() => {
    document.getElementById('purchase-step')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
  }, 50)
}}
          >
            <span className="plan-name-cell">
              <span className="plan-mini-icon">◈</span>
              <span className="plan-name-copy">
                <strong>{bundle.data}</strong>
                <small>Code: {bundle.code}</small>
              </span>
            </span>

            <span className="plan-validity-cell">
              {bundle.validity || 'Provider plan'}
            </span>

            <strong className="plan-price-cell">
              {formatNaira(bundle.price)}
            </strong>

            <span className="plan-action-cell">
              {selectedBundle?.id === bundle.id
                ? '✓ Selected'
                : 'Select →'}
            </span>
          </button>
        ))}
      </div>

      <div className="plans-table-footer">
        <span>{dataPlans.length} plans available</span>
        <span>Scroll to explore more ↓</span>
      </div>
    </>
  )}
</div>


          
{showPurchaseStep && selectedBundle && (
  <section
    className="purchase-step"
    id="purchase-step"
    aria-labelledby="purchase-step-title"
  >
    <div className="purchase-step-heading">
      <div>
        <p className="eyebrow">STEP 2 OF 2</p>
        <h3 id="purchase-step-title">Complete your data purchase</h3>
        <p>Confirm your bundle and enter the recipient's number.</p>
      </div>

      <button
        type="button"
        className="purchase-back-button"
        onClick={() => {
          setShowPurchaseStep(false)
          setNotice('')
        }}
      >
        ← Change plan
      </button>
    </div>

    <div className="purchase-summary">
      <div className="purchase-summary-network">
        <span className="plan-mini-icon">◈</span>
        <div>
          <small>SELECTED NETWORK</small>
          <strong>{selectedNetwork}</strong>
        </div>
      </div>

      <div className="purchase-summary-plan">
        <small>DATA BUNDLE</small>
        <strong>{selectedBundle.data}</strong>
        <span>Plan code: {selectedBundle.code}</span>
      </div>

      <div className="purchase-summary-price">
        <small>TOTAL PRICE</small>
        <strong>{formatNaira(selectedBundle.price)}</strong>
      </div>
    </div>

    <div className="recipient-field purchase-recipient">
      <label htmlFor="recipientPhone">
        Recipient phone number
      </label>

      <input
        id="recipientPhone"
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        placeholder="08012345678"
        value={recipientPhone}
        onChange={(event) =>
          setRecipientPhone(
            event.target.value.replace(/\D/g, '').slice(0, 11)
          )
        }
        maxLength={11}
        required
        aria-describedby="recipientPhoneHelp"
      />

      <small id="recipientPhoneHelp">
        Enter the 11-digit Nigerian number that should receive the data.
      </small>
    </div>

    <div className="purchase-wallet-info">
      <span>Available wallet balance</span>
      <strong>
        {walletLoading || walletBalance === null
          ? 'Loading balance...'
          : formatNaira(walletBalance)}
      </strong>
    </div>

    {walletBalance !== null &&
      Number.isFinite(walletBalance) &&
      walletBalance < selectedBundle.price && (
        <p className="purchase-warning" role="status">
          Your wallet balance is insufficient for this plan.
          Please fund your wallet before purchasing.
        </p>
      )}

    <button
      type="button"
      className="gold-button purchase-ready-button"
      disabled={
        !/^\d{11}$/.test(recipientPhone) ||
        walletLoading ||
        walletBalance === null ||
        !Number.isFinite(walletBalance) ||
        walletBalance < selectedBundle.price
      }
      onClick={handleBuyData}
    >
      Review purchase · {formatNaira(selectedBundle.price)}
      <span>→</span>
    </button>

    <p className="purchase-security-note">
      Your wallet will not be charged during this review step.
    </p>
  </section>
)}


          <p className="demo-note">
   Review your selected
  bundle and recipient number before continuing.
</p>
        </section>

        <section className="transactions-section" id="transactions">
          <div className="section-heading transaction-heading">
            <div><p className="eyebrow">YOUR ACTIVITY</p><h2>Recent transactions<span className="gold-text">.</span></h2></div>
            <a href="/orders">View all ↗</a>
          </div>
          
<div className="transaction-table">
  <div className="transaction-header">
    <span>TRANSACTION</span>
    <span>STATUS</span>
    <span>AMOUNT</span>
  </div>

  {transactionsLoading && (
    <p className="transaction-message">
      Loading your transactions...
    </p>
  )}

  {!transactionsLoading && transactionsError && (
    <p className="transaction-message" role="alert">
      {transactionsError}
      <button
        type="button"
        onClick={() =>
          setTransactionsRefresh((previous) => previous + 1)
        }
      >
        Retry
      </button>
    </p>
  )}

  {!transactionsLoading &&
    !transactionsError &&
    walletTransactions.length === 0 && (
      <p className="transaction-message">
        No transactions yet. Your wallet activity will appear here.
      </p>
    )}

  {!transactionsLoading &&
    !transactionsError &&
    walletTransactions.map((transaction) => {
      const type = String(transaction.type || '').toLowerCase()
      const status = String(transaction.status || '').toLowerCase()

      const title =
        transaction.description ||
        ({
          deposit: 'Wallet funding',
          withdrawal: 'Wallet withdrawal',
          investment: 'Investment',
          earning: 'Wallet earning',
        }[type] || 'Wallet transaction')

      const amount = Number(transaction.amount)
      const isDeposit = type === 'deposit'
      const isCredit = isDeposit || type === 'earning'

      const statusLabel = {
        completed: 'Completed',
        pending: 'Pending',
        failed: 'Failed',
      }[status] || status

      return (
        <div className="transaction-row" key={transaction._id}>
          <div className="transaction-name">
            <span className={`transaction-icon ${type}`}>
              {isCredit ? '↓' : '↗'}
            </span>

            <span>
              <strong>{title}</strong>
              <small>
                {transaction.createdAt
                  ? new Date(transaction.createdAt).toLocaleString(
                      'en-NG',
                      {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }
                    )
                  : 'Date unavailable'}
              </small>
            </span>
          </div>

          <span
            className={`transaction-status ${
              status === 'completed'
                ? 'completed'
                : 'empty-status'
            }`}
          >
            {statusLabel}
          </span>

          <strong
            className={
              isCredit && status === 'completed'
                ? 'positive-amount'
                : 'muted-amount'
            }
          >
            {Number.isFinite(amount)
              ? `${isCredit ? '+' : '−'}${formatNaira(amount)}`
              : '—'}
          </strong>
        </div>
      )
    })}
</div>

        </section>

        <footer className="footer">
          <a className="footer-brand" href="#home">Data<span className="gold-text">Gold</span></a>
          <span>Simple connections. Smarter living.</span>
          <span>© {new Date().getFullYear()} DataGold</span>
        </footer>
      </main>

      
{showFundModal && (
  <div
    className="fund-modal-overlay"
    onClick={() => {
      if (!funding) setShowFundModal(false)
    }}
  >
    <section
      className="fund-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="fund-modal-title"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="fund-modal-close"
        onClick={() => setShowFundModal(false)}
        disabled={funding}
        aria-label="Close funding modal"
      >
        ×
      </button>

      <p className="eyebrow">WALLET FUNDING</p>

      <h2 id="fund-modal-title">Add money to your wallet</h2>

      <p className="fund-modal-description">
        Enter the amount you want to add. You will complete
        your payment securely on Paystack.
      </p>

      <form onSubmit={handleSubmitFundWallet}>
        <label htmlFor="fund-amount">Amount in naira (NGN)</label>

        <div className="fund-amount-input">
          <span>₦</span>
          <input
            id="fund-amount"
            type="number"
            min="100"
            max="5000000"
            step="1"
            value={fundAmount}
            onChange={(event) => setFundAmount(event.target.value)}
            required
            disabled={funding}
            autoFocus
          />
        </div>

        <p className="fund-modal-hint">
          Minimum ₦100 · Maximum ₦5,000,000
        </p>

        {fundError && (
          <p className="fund-modal-error" role="alert">
            {fundError}
          </p>
        )}

        <button
          className="gold-button fund-submit-button"
          type="submit"
          disabled={funding}
        >
          {funding
            ? 'Connecting to Paystack...'
            : 'Continue to Paystack ↗'}
        </button>
      </form>

      <p className="fund-modal-secure">
        Payments are verified by the DataGold backend.
      </p>
    </section>
  </div>
)}

    </div>
  )
}

export default Dashboard
