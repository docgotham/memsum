import { Claim } from "./claim";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <Claim token={token} />;
}
