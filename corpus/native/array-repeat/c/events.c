static int events;
void silk_repeat_event(int value) { events = events * 10 + value; }
int silk_repeat_events(void) { return events; }
