import { EntityPage } from "../../components/entity-page"
import { SitePlaybook } from "../../components/ring/site-playbook"

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <EntityPage kind="site" params={params} extra={<SitePlaybook siteId={id} />} />
}
