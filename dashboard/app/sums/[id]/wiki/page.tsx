import { WikiIndex } from "./index-view";

export default async function WikiIndexPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WikiIndex relationshipId={id} />;
}
