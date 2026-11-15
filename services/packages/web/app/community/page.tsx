import { PageGuide } from "@/components/PageGuide";
import { ChatView } from "@/components/community/ChatView";
import { CommunityGate } from "@/components/community/shell";
import { ComingSoon, OrryHead } from "@/components/orry/parts";

export const metadata = { title: "Orrery · Community", description: "Chat with Orrery holders on chain, pick a username and tip the messages you like in ORRY." };

export default function CommunityPage() {
  return (
    <>
      <CommunityGate
        feature="chat"
        held={
          <>
            <OrryHead title="Talk with Orrery holders, on chain." lead={<p>Every message is a transaction, and each post pays a small fee in ORRY to the Reward Pool.</p>} />
            <ComingSoon title="Community chat opens soon." text="Rooms, usernames and tips appear on this page when the chat opens." />
          </>
        }
      >
        <ChatView />
      </CommunityGate>
      <PageGuide
        audience={"Anyone holding ORRY who wants to talk with other holders."}
        steps={[
          { title: "Pick a username", text: "One name per wallet, shown beside your messages. Changing it frees the old one." },
          { title: "Post", text: "Each post pays its fee in ORRY to the Reward Pool. Staker rooms take posts from wallets with enough ORRY earning in Stake." },
          { title: "Reply and tip", text: "Tips go to the author, minus a small share for the Reward Pool." },
        ]}
      />
    </>
  );
}
