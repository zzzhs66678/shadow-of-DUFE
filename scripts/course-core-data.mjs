export function buildCourseCorePayload(courseData) {
  const courseTitles = courseData.courses.map((course) => [
    course.id,
    course.title,
  ]);
  const courseIndexes = new Map(
    courseTitles.map(([courseId], index) => [courseId, index]),
  );

  const dictionary = (values) => {
    const items = [...new Set(values)];
    return {
      items,
      indexes: new Map(items.map((item, index) => [item, index])),
    };
  };
  const teachers = dictionary(courseData.schedules.map((item) => item.teacher));
  const timeTexts = dictionary(courseData.schedules.map((item) => item.timeText));
  const venues = dictionary(courseData.schedules.map((item) => item.building));
  const rooms = dictionary(courseData.schedules.map((item) => item.room));

  return {
    version: 1,
    catalogId: courseData.catalogId,
    generatedAt: courseData.generatedAt,
    source: courseData.source,
    disclaimer: courseData.disclaimer,
    periods: courseData.periods,
    buildings: courseData.buildings,
    colleges: courseData.colleges,
    majors: courseData.majors,
    quality: courseData.quality,
    courseTitles,
    dictionaries: {
      teachers: teachers.items,
      timeTexts: timeTexts.items,
      venues: venues.items,
      rooms: rooms.items,
    },
    schedules: courseData.schedules.map((item) => [
      item.id,
      item.term === "fall" ? 0 : 1,
      courseIndexes.get(item.courseId),
      teachers.indexes.get(item.teacher),
      item.weekday,
      item.block,
      item.weeks,
      timeTexts.indexes.get(item.timeText),
      venues.indexes.get(item.building),
      rooms.indexes.get(item.room),
    ]),
  };
}
