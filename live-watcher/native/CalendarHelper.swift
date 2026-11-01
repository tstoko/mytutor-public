import Foundation
import EventKit

// Read conflict calendars; write only journaled confirmed free bookings.
// No access prompt except explicit --authorize.
@main struct CalendarHelper {
    static func main() async {
        let store = EKEventStore()
        do {
            if CommandLine.arguments.contains("--authorize") {
                guard try await store.requestFullAccessToEvents() else {
                    throw NSError(domain: "MyTutor", code: 1, userInfo: [NSLocalizedDescriptionKey:"Calendar access denied"])
                }
            }
            guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else {
                throw NSError(domain: "MyTutor", code: 2, userInfo: [NSLocalizedDescriptionKey:"Calendar permission not granted; authorize the helper explicitly"])
            }
            let required = ["Tutoring", "General", "Other"]
            let calendars = store.calendars(for: .event)
            var selected: [EKCalendar] = []
            for name in required {
                let matches = calendars.filter { $0.title == name && $0.source.sourceType == .calDAV && $0.source.title == "iCloud" }
                guard matches.count == 1 else {
                    throw NSError(domain:"MyTutor", code:3,userInfo:[NSLocalizedDescriptionKey:"Expected exactly one iCloud calendar: \(name)"])
                }
                selected.append(matches[0])
            }
            let format = ISO8601DateFormatter()
            let args = CommandLine.arguments
            if args.count == 4 && args[1] == "--journal-action" {
                let result = try journalAction(store:store, calendars:selected, actionID:args[2], token:args[3], format:format)
                let data = try JSONSerialization.data(withJSONObject:result, options:[.sortedKeys])
                print(String(decoding:data,as:UTF8.self)); return
            }
            let start = args.count == 4 && args[1] == "--read" ? format.date(from: args[2]) : Date()
            let end = args.count == 4 && args[1] == "--read" ? format.date(from: args[3]) : Date().addingTimeInterval(7*86400)
            guard let start = start, let end = end, end > start, end.timeIntervalSince(start) <= 31*86400 else {
                throw NSError(domain:"MyTutor",code:4,userInfo:[NSLocalizedDescriptionKey:"Invalid calendar interval"])
            }
            let predicate = store.predicateForEvents(withStart:start,end:end,calendars:selected)
            let events: [[String:Any]] = store.events(matching:predicate).map { event in
                ["id":event.eventIdentifier ?? "", "calendar":event.calendar.title, "title":event.title ?? "", "start":format.string(from:event.startDate), "end":format.string(from:event.endDate), "all_day":event.isAllDay]
            }
            let result: [String:Any] = ["success":true,"checked_at":format.string(from:Date()),"calendars":required,"events":events,"mode":"read_only"]
            let data = try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys])
            print(String(decoding:data,as:UTF8.self))
        } catch {
            let data = try! JSONSerialization.data(withJSONObject:["success":false,"blocker":error.localizedDescription])
            print(String(decoding:data,as:UTF8.self)); exit(1)
        }
    }
    static func journalAction(store: EKEventStore, calendars: [EKCalendar], actionID: String, token: String, format: ISO8601DateFormatter) throws -> [String:Any] {
        func fail(_ reason:String) -> NSError { NSError(domain:"MyTutor",code:5,userInfo:[NSLocalizedDescriptionKey:reason]) }
        let root=FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/MyTutorLive/runtime")
        func json(_ name:String) throws -> [String:Any] {
            guard let value=try JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent(name))) as? [String:Any] else {throw fail("Invalid journal")};return value
        }
        let lease=try json("workflow-run.json")
        guard lease["status"] as? String == "running", lease["token"] as? String == token else {throw fail("Exclusive workflow ownership required")}
        guard let actions=try json("action-log.json")["actions"] as? [[String:Any]],
              let action=actions.first(where:{$0["id"] as? String == actionID}),
              let kind=action["kind"] as? String, ["calendar_create","calendar_update","calendar_cancel"].contains(kind),
              ["pending","needs_review"].contains(action["status"] as? String ?? ""),
              action["run_token"] as? String == token,
              let entity=action["entity_id"] as? String,
              let details=action["details"] as? [String:Any], details["confirmed"] as? Bool == true,
              details["calendar"] as? String == "Tutoring",
              let startText=details["start"] as? String, let endText=details["end"] as? String,
              let start=format.date(from:startText), let end=format.date(from:endText), end>start,
              let student=details["student"] as? String, !student.isEmpty,
              let subject=details["subject"] as? String,
              ["Mathematics","Further Mathematics","Economics","Politics"].contains(subject),
              let link=details["booking_link"] as? String, let url=URL(string:link), url.scheme == "https", url.host == "www.mytutor.co.uk", url.path.hasPrefix("/tutors/secure/") else {throw fail("Invalid pending calendar action")}
        guard actions.contains(where:{$0["entity_id"] as? String == entity && $0["kind"] as? String == "acceptance" && $0["status"] as? String == "completed" && ($0["details"] as? [String:Any])?["free_meeting"] as? Bool == true}) else {throw fail("Completed free-meeting acceptance required")}
        let calendar=calendars.first(where:{$0.title == "Tutoring"})!
        guard calendar.allowsContentModifications else {throw fail("Tutoring calendar is not writable")}
        let marker="MyTutor booking ID: " + entity
        let title="MyTutor free meeting – " + student + " – " + subject
        let notes=marker+"\n"+link
        let predicate=store.predicateForEvents(withStart:start.addingTimeInterval(-31*86400),end:end.addingTimeInterval(31*86400),calendars:[calendar])
        let nearby=store.events(matching:predicate)
        guard !nearby.contains(where: { $0.url == url && !($0.notes ?? "").components(separatedBy:"\n").contains(marker) }) else {throw fail("An unmarked event already links to this booking; reconcile manually")}
        var matches=nearby.filter { ($0.notes ?? "").components(separatedBy:"\n").contains(marker) }
        if let id=details["event_id"] as? String, let existing=store.event(withIdentifier:id), !matches.contains(where:{$0.eventIdentifier == existing.eventIdentifier}) {matches.append(existing)}
        guard matches.count<=1 else {throw fail("Duplicate marked calendar events; inspect manually")}
        if kind != "calendar_create" {
            guard let id=details["event_id"] as? String, matches.count == 1, matches[0].eventIdentifier == id,
                  matches[0].calendar.calendarIdentifier == calendar.calendarIdentifier,
                  (matches[0].notes ?? "").components(separatedBy:"\n").contains(marker), matches[0].recurrenceRules == nil else {throw fail("Existing owned event identity required")}
        }
        if kind == "calendar_cancel" {
            let event=matches[0];let id=event.eventIdentifier ?? ""
            try store.remove(event,span:.thisEvent,commit:true)
            guard store.event(withIdentifier:id) == nil else {throw fail("Cancellation not verified")}
            return ["success":true,"event_id":id,"cancelled":true,"verified_at":format.string(from:Date())]
        }
        if kind == "calendar_create", let event=matches.first {
            guard event.title == title, event.startDate == start, event.endDate == end, event.url == url,
                  event.notes == notes, !event.isAllDay else {throw fail("Marked event differs; reconcile instead of duplicating")}
            return ["success":true,"event_id":event.eventIdentifier ?? "","recovered":true,"verified_at":format.string(from:Date())]
        }
        let event=matches.first ?? EKEvent(eventStore:store)
        event.calendar=calendar;event.title=title;event.startDate=start;event.endDate=end
        event.isAllDay=false;event.timeZone=TimeZone(identifier:"Europe/London");event.url=url;event.notes=notes
        try store.save(event,span:.thisEvent,commit:true)
        guard let id=event.eventIdentifier, let saved=store.event(withIdentifier:id), saved.title == title,
              saved.startDate == start, saved.endDate == end, saved.url == url, saved.notes == notes,
              saved.calendar.calendarIdentifier == calendar.calendarIdentifier, !saved.isAllDay else {throw fail("Saved calendar event not verified")}
        return ["success":true,"event_id":id,"title":title,"start":startText,"end":endText,"booking_link":link,"verified_at":format.string(from:Date())]
    }

}
