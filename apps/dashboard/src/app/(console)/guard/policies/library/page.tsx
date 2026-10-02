import { redirect } from 'next/navigation';

export default function GuardPolicyLibraryPage() {
  redirect('/guard/policies?tab=templates');
}
