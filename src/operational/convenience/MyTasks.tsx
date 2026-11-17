import { Home, type HomeProps } from "./Home";
export function MyTasks(props: HomeProps) {
  return <Home {...props} tasksOnly />;
}
