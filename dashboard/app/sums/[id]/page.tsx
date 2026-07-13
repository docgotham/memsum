import { SumDetail } from "./detail";

export default async function SumPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SumDetail relationshipId={id} />;
}
