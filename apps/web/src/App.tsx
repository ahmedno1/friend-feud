import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'

const views = [
  { path: '/team-one', label: 'المتسابق الأول', short: '01' },
  { path: '/team-two', label: 'المتسابق الثاني', short: '02' },
  { path: '/host', label: 'الهوست', short: '03' },
  { path: '/display', label: 'شاشة العرض', short: '04' },
]

function WorkspaceView({ title, index }: { title: string; index: string }) {
  return (
    <section className="view-panel" aria-labelledby="view-title">
      <span className="view-index" aria-hidden="true">{index}</span>
      <h1 id="view-title">{title}</h1>
      <span className="view-status"><span /> جاهز للربط</span>
    </section>
  )
}

function App() {
  const location = useLocation()
  const activeView = views.find((view) => view.path === location.pathname)

  return (
    <main className="workspace" dir="rtl">
      <header className="workspace-header">
        <Link className="wordmark" to="/team-one" aria-label="Friend Feud، الواجهة الرئيسية">
          <span className="wordmark-mark">F</span>
          <span>FRIEND FEUD</span>
        </Link>
        <span className="environment"><span /> بيئة التطوير</span>
      </header>

      <nav className="view-nav" aria-label="واجهات المشروع">
        {views.map((view) => (
          <Link
            aria-current={activeView?.path === view.path ? 'page' : undefined}
            className="view-link"
            key={view.path}
            to={view.path}
          >
            <span className="nav-index">{view.short}</span>
            <span>{view.label}</span>
          </Link>
        ))}
      </nav>

      <Routes>
        <Route path="/" element={<Navigate replace to="/team-one" />} />
        {views.map((view) => (
          <Route
            key={view.path}
            path={view.path}
            element={<WorkspaceView title={view.label} index={view.short} />}
          />
        ))}
        <Route path="*" element={<Navigate replace to="/team-one" />} />
      </Routes>

      <footer className="workspace-footer">
        <span>FRIEND FEUD</span>
        <span>LOCAL DEVELOPMENT</span>
      </footer>
    </main>
  )
}

export default App
