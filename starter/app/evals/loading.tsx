import { AppFrame } from "../components/app-frame"
import { RingoFace } from "../components/ringo"
import "./evals.css"

export default function Loading() {
  return <AppFrame><main className="page" aria-busy="true">
    <div className="trust-intro"><RingoFace size={64} /><div><h1 className="page-title small">How we test Ringo</h1><p className="intro">Pulling the test results.</p></div></div>
    <div className="tiles ev-tiles">{[0, 1, 2].map((i) => <div className="q-skel tall" key={i} />)}</div>
    <div className="ev-cards ev-skel">{[0, 1, 2, 3].map((i) => <div className="q-skel tall" key={i} />)}</div>
  </main></AppFrame>
}
