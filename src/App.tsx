import { Route, Routes } from 'react-router-dom'
import { WalletGate } from './components/WalletGate'
import { Dashboard } from './pages/Dashboard'
import { CreateEscrow } from './pages/CreateEscrow'
import { EscrowDetail } from './pages/EscrowDetail'

function App () {
  return (
    <WalletGate>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/new" element={<CreateEscrow />} />
        <Route path="/e/:escrowId" element={<EscrowDetail />} />
        <Route path="/e/:escrowId/p/:proposalId" element={<EscrowDetail />} />
      </Routes>
    </WalletGate>
  )
}

export default App
