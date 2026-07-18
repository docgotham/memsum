import { WikiPageView } from "./view";

export default async function WikiPage({ params }: { params: Promise<{ id: string; path: string[] }> }) {
  const { id, path } = await params;
  return <WikiPageView relationshipId={id} segments={path} />;
}
