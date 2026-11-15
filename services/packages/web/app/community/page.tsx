import { PageGuide } from "@/components/PageGuide";
import { ChatView } from "@/components/community/ChatView";
import { CommunityGate } from "@/components/community/shell";
import { ComingSoon, OrryHead } from "@/components/orry/parts";

export const metadata = { title: "Orrery · Community", description: "Talk with other ORRY holders on chain, claim a username, and send ORRY tips to the posts worth reading." };

export default function CommunityPage() {
  return (
    <>
      <CommunityGate
        feature="chat"
        held={
          <>
            <OrryHead title="Holder talk, written to the chain." lead={<p>Each message is its own transaction, and every post sends a small ORRY fee to the Reward Pool.</p>} />
            <ComingSoon title="Community chat starts soon." text="Rooms, usernames and tips show here once the chat starts." />
          </>
        }
      >
        <ChatView />
      </CommunityGate>
      <PageGuide
        audience={"ORRY holders who want a word with other holders."}
        steps={[
          { title: "Claim a username", text: "Each wallet holds one name, printed next to its messages. Pick a new one and the old name is free again." },
          { title: "Post", text: "Every post sends its ORRY fee to the Reward Pool. Staker rooms accept posts only from wallets with enough ORRY earning in Stake." },
          { title: "Reply or tip", text: "A tip reaches the author, less a small cut kept for the Reward Pool." },
        ]}
      />
    </>
  );
}
