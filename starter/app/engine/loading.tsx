import { AppFrame } from "../components/app-frame"

export default function Loading() {
  return <AppFrame><main className="page" aria-busy="true">
    <h1 className="page-title small">Technical trace</h1>
    {[0, 1, 2, 3].map((i) => <div className="q-skel" key={i} />)}
  </main></AppFrame>
}
