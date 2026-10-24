// Server gate for the order pages: an unknown id is a real 404 (no client fetches), and the tab names the order.
import type { Metadata } from "next"
import type { ReactNode } from "react"
import { notFound } from "next/navigation"
import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { orders } from "@/lib/schema"

type Props = { params: Promise<{ id: string }> }

const reference = async (id: string) => (await db.select({ reference: orders.reference }).from(orders).where(eq(orders.id, id)).limit(1))[0]?.reference

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: (await reference((await params).id)) ?? "Order not found" }
}

export default async function OrderLayout({ params, children }: Props & { children: ReactNode }) {
  if (!(await reference((await params).id))) notFound()
  return children
}
