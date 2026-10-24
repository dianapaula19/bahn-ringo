import { withBase } from "@/lib/base"

/** Ringo's head and shoulders, cropped from public/ringo.svg with CSS (.ringo-face). */
export function RingoFace({ size = 26 }: { size?: number }) {
  return <span className="ringo-face" style={{ width: size, height: size }}>
    {/* eslint-disable-next-line @next/next/no-img-element -- a static svg needs no optimiser */}
    <img src={withBase("/ringo.svg")} alt="Ringo" />
  </span>
}
